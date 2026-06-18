---
name: agy-architecture-scripts
description: "Deep per-file map of the agy plugin's executable core — agy-companion.mjs (CLI router), lib/agy.mjs (runtime bridge), the state/job layer (state/tracked-jobs/job-control/workspace), the two hooks, and the utility libs (git/process/fs/prompts/args/render)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5522a8ac-b944-4844-a9d9-73189c3d84ed
---

# agy plugin — executable core (scripts + libs) deep map

Child of [[agy-architecture-overview]]. Covers everything under `plugins/agy/scripts/` except the dormant broker ([[agy-architecture-broker]]). Line cites like `agy.mjs:NNN`.

## 1. `agy-companion.mjs` (1033) — CLI command router
Single Node entry every slash command / the rescue subagent / the stop hook shells out to: `node agy-companion.mjs <subcommand> [flags]`. Top-level `switch(subcommand)` in `main()` (`:987`); unknown → throws → top catch (`:1029`) writes `error.message` (one line, no stack) to stderr + exit 1. Single quoted `"$ARGUMENTS"` is re-tokenized by `normalizeArgv` via `splitRawArgumentString`. All handlers parse flags through `parseCommandInput` (always injects alias `-C → cwd`) and resolve cwd→git root via `resolveCommandWorkspace`.

**Subcommands:**
- `setup` (`handleSetup :212`) — `[--enable-review-gate|--disable-review-gate] [--cwd] [--json]`. Toggles `stopReviewGate` config; `buildSetupReport` checks node/npm (`binaryAvailable`), agy availability+auth, runtime status, builds `nextSteps`; `ready = node.available && agy.available`.
- `review` (`handleReview :731` → `handleReviewCommand :688`) — `[--base <ref>] [--scope auto|working-tree|branch] [--model] [--cwd] [--json]`. `validateNativeReviewRequest` **rejects focus text** (sends you to adversarial) and unsupported targets. Built-in reviewer via `runAppServerReview`.
- `adversarial-review` (`:1001`, `reviewName:"Adversarial Review"`) — same + trailing focus text allowed. `collectReviewContext` → `buildAdversarialReviewPrompt` (interpolates `prompts/adversarial-review.md`) → `runAppServerTurn` read-only with `REVIEW_SCHEMA` → `parseStructuredOutput` → `renderReviewResult`.
- `task` (`handleTask :738`) — `[--background] [--write] [--resume-last|--resume|--fresh] [--model] [--effort none|minimal|low|medium|high] [--prompt-file] [--cwd] [--json] [prompt]`. Prompt from `--prompt-file` > positionals > piped stdin. `--resume`+`--fresh` throws. **Background**: `enqueueBackgroundTask` writes a `queued` job + spawns detached `task-worker`. **Foreground**: `runForegroundCommand` → `executeTaskRun` → `runAppServerTurn` (sandbox `workspace-write` if `--write`). `--effort` validated but **no-op** on backend. Reached only via the rescue subagent + stop hook (not the slash commands directly).
- `task-worker` (`handleTaskWorker :801`, internal) — `--cwd --job-id`; re-reads the stored job's serialized `request` and runs it via `runTrackedJob`. This is the detached child's body.
- `status` (`handleStatus :846`) — `[job-id] [--all] [--wait] [--timeout-ms] [--poll-interval-ms] [--json]`. With id+`--wait`, polls (default 240000ms/2000ms) until terminal or deadline (`waitTimedOut`). Without id, `--wait` throws.
- `result` (`handleResult :873`) — latest finished (completed/failed/cancelled) job, or by id; throws if still running.
- `task-resume-candidate` (`handleTaskResumeCandidate :891`) — newest finished `task` job with a `threadId`, session-filtered. Used by `/agy:rescue` to decide whether to offer "continue".
- `cancel` (`handleCancel :926`) — no-op `interruptAppServerTurn` + `terminateProcessTree(job.pid)` + write `status:"cancelled"`, `pid:null`, `cancelledAt`.

Constants: `DEFAULT_STATUS_WAIT_TIMEOUT_MS=240000`, `DEFAULT_STATUS_POLL_INTERVAL_MS=2000`, `VALID_REASONING_EFFORTS`, `STOP_REVIEW_TASK_MARKER` ("Run a stop-gate review of the previous Claude turn." — duplicated literally in `stop-review-gate-hook.mjs:19`; companion uses it only to relabel the job title). `spawnDetachedTaskWorker` (`:649`) passes the FULL `process.env` to the child.

## 2. `lib/agy.mjs` (843) — THE runtime bridge
Only module that knows the `agy` command shape and transcript layout. **Everything is synchronous** (spawnSync + sync file reads); the `async` signatures are caller ergonomics.

- **`resolveAgyCommand`** (`:108`) — `AGY_BIN` || `agy`, + optional leading `AGY_BIN_ARG`.
- **`spawnAgy`** (`:514`) — `spawnSync` with `maxBuffer:64MiB`, `windowsHide:true`, `timeout:resolveAgyTimeoutMs()`, `input:""` (closes child stdin so `--write` confirmation prompts see EOF). First try `shell:false`; **Windows ENOENT fallback** retries `shell:true` (finds `.cmd` shim).
- **`runAppServerTurn`** (`:547`) — core. Builds `["--print", ...]`: resume → `--conversation <uuid>` or `--continue`; prompt positional; `--model`; `--print-timeout` if `AGY_PRINT_TIMEOUT`; sandbox flags last (`buildSandboxArgs :496`: read-only ADDS `--sandbox` unless `AGY_NO_SANDBOX=1`; write passes only `AGY_SANDBOX_WRITE` flags). Snapshots existing conversation ids BEFORE spawn (for correlation). After: settle-loop re-reads transcript up to `TRANSCRIPT_SETTLE_TOTAL_MS=1200` in `150ms` steps (`AGY_TRANSCRIPT_SETTLE_MS=0` disables). Persists a per-RUN answer file.
- **`runAppServerReview`** (`:734`) — builds a senior-engineer review prompt, calls `runAppServerTurn` hard-coded `sandbox:"read-only"`, reshapes `finalMessage`→`reviewText`.
- **`getAntigravityAvailability`** (`:141`) — `agy --version`; classifies ENOENT/spawn-error/non-zero/ok. No version pinning. **`getAntigravityAuthStatus`** (`:190`) — probes OS credential marker files (`oauth_creds.json` etc.); always `verified:false`.
- **`parseStructuredOutput`/`stripCodeFence`** (`:808`/`:795`) — de-fence ```` ```json ```` then `JSON.parse`; preserves original `rawOutput`; never throws.
- **`getSessionRuntimeStatus`** (`:223`) — static `{mode:"direct"}`. **`interruptAppServerTurn`** (`:770`) — no-op `{attempted:false}`. **`findLatestTaskThread`** (`:764`) — newest brain dir by mtime.

**Quirk handling (the module's whole reason to exist):**
- *Stdout silent / empty tool-call turns*: reads transcript (`readTranscript :467`); `parseTranscriptText :424` finds last `MODEL`/`DONE`/`PLANNER_RESPONSE` via `isFinalModelEntry`, `extractEntryText :399` probes many key names. Failure rule (`:653`): `failed = spawnFailed || (!finalMessage && !sawFinalEntry)` — **an empty answer WITH a final entry is SUCCESS** (note `emptyAnswerNote`). This is the F23/F24 fix.
- *Transcript flush race*: bounded settle re-read loop.
- *`--write` reports failure*: same empty-but-final=success logic + `input:""`.
- *AGY_STATE_DIR ignored by binary*: `resolveStateDir :97` is used only to READ transcripts/creds; never injected into the agy child env.
- *Concurrent threadId misattribution*: `resolveConversationId :310` correlates by **set-difference** of conversation ids (before/after), not mtime; if multiple new appeared it falls back to newest-mtime (documented best-effort residual). See [[agy-real-runtime-behavior]].
- *Timeout*: ETIMEDOUT/kill-signal → hard failure `diagnostic:"timeout"` (a stale transcript can't fake success).
- *No transcript at all*: `diagnostic:"auth-or-incomplete"` + run-`agy`-interactively hint.

## 3. State / job layer — daemonless persistence
Four files; shared files on disk ARE the job model (no daemon).

**`workspace.mjs` (9)** — `resolveWorkspaceRoot(cwd)` = `ensureGitRepository(cwd)` (git toplevel), falling back to `cwd` on any throw.

**`state.mjs` (346)** — owns the on-disk store.
- `resolveStateDir(cwd)` (`:67`) — `<stateRoot>/<slug>-<hash>`. `stateRoot` = `$CLAUDE_PLUGIN_DATA/state` or `os.tmpdir()/Antigravity-companion`. `slug` = sanitized **raw** basename; `hash` = `sha256(realpathSync.native(workspaceRoot))[:16]` (slug/hash asymmetry: realpath'd paths collide on hash regardless of basename). **No `AGY_STATE_DIR` override here.**
- Layout: `state.json`, `jobs/<id>.json`, `jobs/<id>.log`, `answers/<id>.json`, `.state.lock/`, transient `*.tmp`.
- `state.json` = `{version:1, config:{stopReviewGate:false}, jobs:[...≤50, newest-first]}`. Job record accretes fields: `id, kind, jobClass, kindLabel, workspaceRoot, sessionId, logFile, status, phase, pid, createdAt/updatedAt/startedAt/completedAt, threadId, turnId, summary, result, rendered, errorMessage`. Heavy `result`/`rendered` live ONLY in `jobs/<id>.json`; the index keeps a light `summary`.
- `generateJobId(prefix)` (`:266`) = `${prefix}-${base36 time}-${rand6}`. `upsertJob` (`:271`) prepends new / shallow-merges existing + bumps `updatedAt`. `writeAnswerFile` (`:320`) is **exempt from pruning** (durable audit trail; unique per run, even on resume). `atomicWriteFileSync` (`:35`) = temp + `renameSync`.
- Locking: `withStateLock` (`:166`) uses a lock **directory** (`mkdirSync` atomic; `EEXIST` = held). Budget `LOCK_TOTAL_BUDGET_MS=2000`, retry `25`, stale-break `10000`. **Degrades to last-writer-wins; never deadlocks/throws.** `updateState` re-loads inside the lock. `saveStateUnlocked` prunes to 50 and deletes evicted jobs' `.json`+`.log`.

**`tracked-jobs.mjs` (204)** — `SESSION_ID_ENV="Antigravity_COMPANION_SESSION_ID"`. `runTrackedJob(job, runner)` (`:142`): flip to `running` (pid=process.pid, startedAt, phase="starting") in both files → `await runner()` returns `{exitStatus, threadId, turnId, summary, payload, rendered}` → write terminal `completed`(exit 0)/`failed` to both, append "Final output" log block → on throw, write `failed`+`errorMessage` then **rethrow**. No `finally`. **`cancelled` is never produced here** — only by the cancel path. `createProgressReporter` fans out to stderr (`[Antigravity] …`) + log + `onEvent`; `createJobProgressUpdater` writes state ONLY when `phase`/`threadId`/`turnId` change (message chatter → log/stderr only).

**`job-control.mjs` (308)** — read-only resolution. `matchJobReference` (`:191`): no-ref→newest; exact id; unique prefix; ambiguous-prefix→throw; none→throw. `buildStatusSnapshot` (session-filtered: running / latestFinished / recent≤8, `--all` lifts cap; `sessionRuntime` from `getSessionRuntimeStatus`). `resolveResultJob` (finished only; throws if still running). `resolveCancelableJob` (active only; >1 in session→ambiguity throw). `enrichJob` adds `kindLabel`, `progressPreview` (last log lines, queued/running/failed only), `elapsed`/`duration`, resolved `phase` (`inferLegacyJobPhase` for old records).

## 4. Hooks (wired in `hooks/hooks.json`)
Both read stdin JSON (`session_id`, `cwd`, `hook_event_name`, `last_assistant_message`).

**`session-lifecycle-hook.mjs` (139)** — `node … SessionStart|SessionEnd` (5s timeout).
- **SessionStart** (`:84`): appends `export Antigravity_COMPANION_SESSION_ID=…` + `export CLAUDE_PLUGIN_DATA=…` to `$CLAUDE_ENV_FILE` (POSIX-escaped). No broker start (lazy). No-ops if `CLAUDE_ENV_FILE` unset.
- **SessionEnd** (`:89`): resolve broker session (`loadBrokerSession` or env fallback) → `sendBrokerShutdown` (graceful) → `cleanupSessionJobs` (kill this session's `queued`/`running` jobs via `terminateProcessTree`, remove them from state) → `teardownBrokerSession` (force) → `clearBrokerSession`. (Broker bits are [[agy-architecture-broker]].)

**`stop-review-gate-hook.mjs` (185)** — `node …` on Stop (900s timeout; internal `STOP_REVIEW_TIMEOUT_MS = 15min`).
- Gate check: if `config.stopReviewGate` falsy → log note to stderr, **ALLOW** (default; flag set by `/agy:setup`). If agy unavailable → log "run /agy:setup", **ALLOW** (fails open).
- `buildStopReviewPrompt`: loads `prompts/stop-review-gate.md`, interpolates `{{CLAUDE_RESPONSE_BLOCK}}` from `last_assistant_message`.
- `runStopReview`: `spawnSync(node, [agy-companion.mjs, "task", "--json"], {input:prompt, timeout:15min, env:{...process.env, SESSION_ID_ENV:session_id}})`.
- Verdict (`parseStopReviewOutput`, first line only): `ALLOW:` → allow; `BLOCK:`/empty/unexpected/invalid-JSON/non-zero/timeout → **block** (emit `{decision:"block", reason}` on stdout). **Fails closed.** Allow = silent stdout. Errors set `process.exitCode=1` (not exit, so stdout flushes).

## 5. Utility libs
- **`render.mjs` (465)** — pure formatting, no imports. `renderSetupReport`, `renderReviewResult` (validates shape; degrades to raw+reasoning on parse/shape fail; sorts findings by severity critical<high<medium<low), `renderNativeReviewResult`, `renderTaskResult` (raw output verbatim), `renderStatusReport` (markdown table), `renderJobStatusReport`, `renderStoredJobResult` (appends "Resume in Antigravity: agy --conversation=<id>" when `threadId`), `renderCancelReport`.
- **`git.mjs` (346)** — `ensureGitRepository` (throws "git not installed"/"must run inside a Git repository"). `resolveReviewTarget` (scope precedence: explicit `--base`→branch; `working-tree`; validate scope; `branch`→default branch; **auto**: dirty→working-tree, clean→branch). `collectReviewContext` budgets: inline iff ≤`DEFAULT_INLINE_DIFF_MAX_FILES=2` AND ≤`DEFAULT_INLINE_DIFF_MAX_BYTES=256KiB`, else `inputMode:"self-collect"` (just stats+file lists+guidance). Untracked files inlined only if text (`isProbablyText`) and ≤`MAX_UNTRACKED_BYTES=24KiB`; dirs/broken symlinks/binaries skipped. Over-budget measured via `maxBuffer` ENOBUFS trick.
- **`process.mjs` (135)** — `runCommand` (Windows `shell:SHELL||true`, `windowsHide:true`, never throws). `binaryAvailable`. **`terminateProcessTree(pid)`**: non-finite→no-op (cleanupSessionJobs passes `NaN`); Windows `taskkill /PID <pid> /T /F` ("not found" = already-stopped, ENOENT→`process.kill` fallback); POSIX `kill(-pid, SIGTERM)` (process group), retry single pid; injectable for tests.
- **`fs.mjs` (40)** — `readJsonFile`/`writeJsonFile`, `safeReadFile`, `isProbablyText` (NUL byte in first 4096 → binary), `readStdinIfPiped` (`""` if TTY).
- **`prompts.mjs` (13)** — `loadPromptTemplate(rootDir, name)` reads `<rootDir>/prompts/<name>.md`; `interpolateTemplate` replaces `{{UPPER_SNAKE}}` (unknown→empty).
- **`args.mjs` (130)** — `parseArgs` (valueOptions/booleanOptions/aliasMap Sets; `--` passthrough; unknown long/short → positionals, lenient; value-opts consume next token or throw). `splitRawArgumentString`: **backslash is literal unless followed by `"` `'` `\` or whitespace** (so `C:\Users\me` survives; trailing lone `\` stays literal) — the key Windows-path behavior (regression-tested).
