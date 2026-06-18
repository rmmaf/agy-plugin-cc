---
name: agy-architecture-overview
description: "Complete high-level architecture of the agy plugin — purpose, the real runtime (one-shot `agy --print` + transcript reading), full file inventory, the import/dependency lineage, and the main runtime flows. Anchor for the per-subsystem detail memories."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5522a8ac-b944-4844-a9d9-73189c3d84ed
---

# agy plugin — architecture overview (complete map, anchor doc)

A Claude Code plugin (`plugins/agy/`, name `agy`, v1.0.0, Apache-2.0) that lets Claude Code drive Google's **Antigravity (`agy`) CLI** to run code reviews and delegate coding tasks. It is a **port of an analogous "Codex" plugin** (CHANGELOG only entry = 1.0.0). Codex-era residue still exists: test temp-dir prefix `codex-plugin-test-` in `tests/helpers.mjs`, and `.gitignore` ignores `plugins/codex/.generated/` (not the agy one). Pure Node ESM (`"type":"module"`), **no production deps**, Node ≥18.18 (CI pins Node 22).

This is the anchor. Per-subsystem depth lives in [[agy-architecture-scripts]] (CLI + runtime + state/job + hooks + utils), [[agy-architecture-broker]] (the dormant IPC subsystem), [[agy-architecture-declarative]] (commands/subagent/skills/prompts/schema), [[agy-architecture-tests]] (tests/build/CI). Real-world agy *binary* quirks (vs. plugin code) are in [[agy-real-runtime-behavior]].

## TRUTH #1 — "app server / thread / turn" is legacy naming; the real runtime is a one-shot CLI
The code is littered with names implying a live JSON-RPC "app server" with threads/turns: `runAppServerTurn`, `runAppServerReview`, `interruptAppServerTurn`, `app-server-broker.mjs`, RPC methods `thread/start`/`turn/start`. **Mentally translate all of it to: "one-shot `agy --print <prompt>` subprocess + read the answer from a transcript file on disk."**
- `agy --print` writes **nothing to stdout** under a non-TTY (upstream bug), so the plugin reads the answer from `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (last `MODEL`/`DONE`/`PLANNER_RESPONSE` entry), falling back to sibling `transcript_full.jsonl`.
- `threadId` is really agy's **conversation UUID**. `getSessionRuntimeStatus` always returns `mode:"direct"`. `interruptAppServerTurn` is an honest **no-op** (`attempted:false`) — real cancel = killing the worker process tree.
- All of this lives in `lib/agy.mjs` (the runtime bridge). See [[agy-architecture-scripts]].

## TRUTH #2 — the entire app-server/broker IPC subsystem is dormant scaffolding
`app-server-broker.mjs` + `lib/app-server.mjs` + `lib/broker-lifecycle.mjs` + `lib/broker-endpoint.mjs` implement a real broker daemon (unix socket / Windows named pipe, single-active-request `BROKER_BUSY` serialization). **But no JS file in the plugin ever issues `turn/start`/`thread/start`** — `agy-companion.mjs` and `lib/agy.mjs` contain zero references to the client. The broker exists so the *external* `agy` CLI (which reads `Antigravity_COMPANION_APP_SERVER_ENDPOINT`) could share one upstream connection; the plugin's actual task/review path bypasses it entirely. The SessionEnd hook still dutifully tears it down. Treat it as inactive infrastructure unless that changes. Full detail: [[agy-architecture-broker]].

## TRUTH #3 — daemonless job model
There is no long-lived job process. Every `node agy-companion.mjs <cmd>` invocation reads/writes shared files in a per-workspace state dir, and that shared state IS the job model. **"Background" = the companion spawns a detached copy of itself** (`task-worker --job-id <id>`, `detached:true, stdio:"ignore", unref()`) that writes to the same files. `status`/`result`/`cancel` are separate invocations that read those files. See [[agy-architecture-scripts]].

## Directory inventory (every file, one-line role)
**Entry points — `plugins/agy/scripts/`**
- `agy-companion.mjs` (1033) — central CLI command router; dispatches `setup`/`review`/`adversarial-review`/`task`/`task-worker`/`status`/`result`/`task-resume-candidate`/`cancel`; owns job creation + foreground/background orchestration.
- `app-server-broker.mjs` (252) — standalone broker daemon (DORMANT): one upstream `Antigravity app-server` connection multiplexed to many clients; single-active-request serialization.
- `session-lifecycle-hook.mjs` (139) — SessionStart/SessionEnd hook: writes session id + `CLAUDE_PLUGIN_DATA` into `$CLAUDE_ENV_FILE`; on end, graceful+forced broker teardown and kills this session's active jobs.
- `stop-review-gate-hook.mjs` (185) — Stop hook: optional review gate; when `stopReviewGate` config is on, runs an agy review of the previous Claude turn and emits `{decision:"block"}` if it finds issues.

**Libraries — `plugins/agy/scripts/lib/` (leaf → root)**
- `workspace.mjs` (9) — `resolveWorkspaceRoot`: git toplevel, else `cwd`.
- `prompts.mjs` (13) — `loadPromptTemplate` + `interpolateTemplate` (`{{UPPER_SNAKE}}` tokens).
- `fs.mjs` (40) — `readJsonFile`/`writeJsonFile`, `isProbablyText` (NUL-byte heuristic), `readStdinIfPiped`, temp-dir helper.
- `broker-endpoint.mjs` (41) — `createBrokerEndpoint`/`parseBrokerEndpoint` (`unix:<sock>` vs `pipe:\\.\pipe\<name>`).
- `args.mjs` (130) — `parseArgs` (value/boolean/alias options, lenient) + `splitRawArgumentString` (Windows-backslash-aware tokenizer for the single quoted `$ARGUMENTS`).
- `process.mjs` (135) — `runCommand`/`runCommandChecked`, `binaryAvailable`, `terminateProcessTree` (Windows `taskkill /T /F`; POSIX process-group kill), `formatCommandFailure`.
- `git.mjs` (346) — `ensureGitRepository`, `resolveReviewTarget` (scope auto/working-tree/branch), `collectReviewContext` (diff/status within file+byte budgets → `inline-diff` vs `self-collect`), default-branch detection.
- `state.mjs` (346) — per-workspace state dir resolution, `state.json` (config + ≤50-job index), `jobs/<id>.json`, durable `answers/<id>.json`, atomic temp+rename writes, cross-process `.state.lock` dir.
- `app-server.mjs` (350) — JSON-RPC client (direct-spawn or broker transport) + `AntigravityAppServerClient.connect` transport selection; exports `BROKER_ENDPOINT_ENV`, `BROKER_BUSY_RPC_CODE`. (DORMANT in plugin's own path.)
- `agy.mjs` (843) — **THE runtime bridge.** Invokes `agy --print`, parses the transcript, persists answer files, and implements all the quirk workarounds. Exports `runAppServerTurn`/`runAppServerReview`/`getAntigravityAvailability`/`getAntigravityAuthStatus`/`parseStructuredOutput`/etc.
- `tracked-jobs.mjs` (204) — job record shape, progress reporter (fans out to stderr+log+state), `runTrackedJob` lifecycle wrapper (running→completed/failed); exports `SESSION_ID_ENV`.
- `broker-lifecycle.mjs` (209) — broker spawn/discover/persist/teardown (`broker.json` session file, `PID_FILE_ENV`/`LOG_FILE_ENV`). (Legacy.)
- `job-control.mjs` (308) — read/resolution layer for status/result/cancel: pick job by id/prefix/session/latest, `enrichJob` (phase/elapsed/duration), build snapshots.
- `render.mjs` (465) — ALL human-readable terminal/markdown output (setup report, status table, task/review results, cancel). **Zero imports** — pure string formatting.
- `app-server-protocol.d.ts` — type-only protocol defs; re-exports generated types from `../../.generated/app-server-types/` (NOT committed to the repo).

**Declarative surface — `plugins/agy/`** (full detail in [[agy-architecture-declarative]])
- `.claude-plugin/plugin.json` — manifest. `hooks/hooks.json` — wires the 3 lifecycle hooks.
- `commands/*.md` (7) — `setup`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `rescue`.
- `agents/agy-rescue.md` — the `agy:agy-rescue` subagent (thin `task` forwarder; `model: sonnet`; `tools: Bash`; auto-loads skills `agy-cli-runtime` + `gpt-5-4-prompting`).
- `skills/` (3) — `agy-cli-runtime`, `agy-result-handling`, `gpt-5-4-prompting` (+3 references). All `user-invocable:false`.
- `prompts/` (2) — `adversarial-review.md`, `stop-review-gate.md`. `schemas/review-output.schema.json` — adversarial-review output contract.

**Repo root / tooling** (detail in [[agy-architecture-tests]])
- `.claude-plugin/marketplace.json`, `package.json`, `scripts/bump-version.mjs` (syncs version across 4 manifests), `tsconfig.app-server.json` (noEmit JSDoc type-check of agy/fs/process.mjs), `.github/workflows/pull-request-ci.yml` (test+build on ubuntu+windows, Node 22), `tests/` (11 `*.test.mjs` + `helpers.mjs` + `fake-agy-fixture.mjs`).

## Import/dependency lineage
```
ENTRY POINTS
agy-companion.mjs ........ args, agy, fs, git, process, prompts, state, job-control, tracked-jobs, workspace, render
app-server-broker.mjs .... args, app-server, broker-endpoint
session-lifecycle-hook ... process, app-server(BROKER_ENDPOINT_ENV), broker-lifecycle, state, workspace
stop-review-gate-hook .... agy(getAntigravityAvailability), prompts, state, job-control, tracked-jobs(SESSION_ID_ENV), workspace  [+ spawns agy-companion.mjs]

LIB EDGES (x → y means x imports y)
git → fs, process            workspace → git            state → workspace
agy → fs, state              tracked-jobs → state       job-control → agy, state, tracked-jobs, workspace
broker-lifecycle → broker-endpoint, state               app-server → broker-endpoint, broker-lifecycle, process
render → (none)              broker-endpoint → (node only)
```
Leaf utils: `render` (no deps), `broker-endpoint`, `prompts`, `fs`, `process`, `args`. Deepest chain: entry → state/workspace → git → process+fs.

## Main runtime flows (compact)
1. **Review** — `/agy:review` → `agy-companion review` → `executeReviewRun` → `runAppServerReview` (agy.mjs builds a senior-engineer prompt, runs `agy --print --sandbox` read-only) → parse transcript → `renderNativeReviewResult`. **Adversarial** (`/agy:adversarial-review`): `collectReviewContext` (git diff within budget, else self-collect guidance) → interpolate `prompts/adversarial-review.md` → `runAppServerTurn` (read-only) with `review-output.schema.json` → `parseStructuredOutput` → `renderReviewResult`. Reviews are always foreground in the script; actual backgrounding is Claude Code's own `Bash(run_in_background:true)`.
2. **Task / rescue** — `/agy:rescue` → `agy:agy-rescue` subagent → ONE Bash call `agy-companion task [--write] [--resume-last] [--model X]` → `executeTaskRun` → `runAppServerTurn` (sandbox `workspace-write` if `--write`, else read-only) → transcript → `renderTaskResult`. **Background** (`--background`): `enqueueBackgroundTask` writes a `queued` job + spawns the detached `task-worker`.
3. **status/result/cancel** — separate invocations that read the shared state files via `job-control`. `cancel` = honest no-op `interruptAppServerTurn` + real `terminateProcessTree(job.pid)` + mark `status:"cancelled"`.
4. **Hooks** — SessionStart writes `Antigravity_COMPANION_SESSION_ID` + `CLAUDE_PLUGIN_DATA` to `$CLAUDE_ENV_FILE`; SessionEnd tears down the broker and kills this session's `queued`/`running` jobs; Stop gate (if enabled) runs an agy review of `last_assistant_message` and BLOCKs (`ALLOW:`/`BLOCK:` first-line protocol, fails closed) or ALLOWs.

## Cross-cutting facts (env vars, state layout, quirks)
- **State dir** = `$CLAUDE_PLUGIN_DATA/state/<slug>-<sha256(realpath(workspaceRoot))[:16]>`, else `os.tmpdir()/Antigravity-companion/<slug>-<hash>`. **Keyed per git repo, NOT per Claude session** → multiple sessions in one repo share state (hence session scoping + the broker's BUSY guard). Tmpdir fallback is volatile (lost on temp purge/reboot).
- **Session scoping** via `Antigravity_COMPANION_SESSION_ID` (set by SessionStart hook into `CLAUDE_ENV_FILE`; forwarded to children incl. the stop-gate's `task --json` child). When set, status/result/cancel filter to the current session.
- **agy binary location**: `AGY_BIN` (+ optional `AGY_BIN_ARG`), default `agy` on PATH. Other env knobs read by `agy.mjs`: `AGY_STATE_DIR` (READ-side path only — the real agy ignores it, see [[agy-real-runtime-behavior]]), `AGY_NO_SANDBOX`, `AGY_SANDBOX_WRITE` (extra flags for `--write` runs), `AGY_PRINT_TIMEOUT`, `AGY_TIMEOUT_MS` (default 600000), `AGY_TRANSCRIPT_SETTLE_MS` (default 1200, `0` disables the flush-settle re-read loop).
- **Sandbox inversion**: read-only/review runs ADD `agy --sandbox`; `--write` runs pass NO `--sandbox` (only user-opted `AGY_SANDBOX_WRITE`).
- **Quirk handling** (empty-but-successful tool-call turns, transcript flush race, conversation-id correlation by set-difference, auth-or-incomplete diagnostic, timeout fast-fail) all live in `agy.mjs`. The current code treats an empty answer WITH a final MODEL entry as **success** (locked by the F23/F24 transcript-toolcall tests) — note this supersedes the older "reported as failed" claim in [[agy-real-runtime-behavior]], which described pre-fix plugin behavior; that memory remains accurate about the raw agy binary.
- **`--effort`** is parsed/validated but a **no-op** on the agy backend.
