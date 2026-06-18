---
name: agy-real-runtime-behavior
description: "Observed runtime behaviors of the real agy (Antigravity) CLI v1.0.8 that the plugin depends on but can't be derived from its own code"
metadata: 
  node_type: memory
  type: project
  originSessionId: f8631778-8d06-4036-a366-f3ab1859f90f
---

The `agy-plugin-cc` plugin is a port of the Codex plugin that drives Google Antigravity's `agy` CLI headlessly (`agy --print`, then reads the answer from `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`). E2E tests against the **real `agy` v1.0.8** (installed + authenticated on this machine) surfaced behaviors that are NOT derivable from the plugin source and matter for any future work:

- **Tool-call-terminated turns produce an empty final answer.** When a turn ends on a tool call, every final `MODEL/DONE/PLANNER_RESPONSE` entry has empty `content` + `tool_calls=1`, so `extractEntryText` (agy.mjs) returns "" → the run is reported as **failed ("no readable answer")** even though it succeeded. This is the root cause of write-tasks looking failed.
- **`task --write` persists edits but is reported as a failure.** With `AGY_SANDBOX_WRITE` unset, the real agy still writes the file (confirmed via `git diff`), yet the plugin returns `status:1`. So real rescue write-runs routinely look failed while actually working.
- **The real agy IGNORES `AGY_STATE_DIR`** — it always writes to `~/.gemini/antigravity-cli/brain` regardless of the env var. You cannot redirect/sandbox the real agy's state via env; the plugin's `AGY_STATE_DIR` override only affects the plugin's READ path (and the test fake honors it).
- **Concurrent background tasks misattribute `threadId` for real** — two `task --background` runs sharing the brain dir resolved one job's `threadId` to the OTHER job's conversation (set-difference + newest-mtime tie-break in `resolveConversationId`). Not just theoretical.
- **A `--print` run can write NO brain transcript at all.** When a turn never completes (observed: the session was still authenticating — only 3 `steps` rows in the DB vs ~41 for a healthy run, `cli.log` full of auth/quota/experiment lines), the `brain/<id>/` dir stays EMPTY (no `transcript.jsonl`). So "no transcript entry found" can mean "agy produced nothing", not "read race". The conversation still persists to `conversations/<id>.db` (SQLite) but as **protobuf blobs** (`steps.step_payload`) — NOT readable text, and `sqlite3` isn't guaranteed installed, so the DB is not a usable answer source.
- **A healthy run writes BOTH `transcript.jsonl` AND a sibling `transcript_full.jsonl`** in `.system_generated/logs/`. The full file is a viable fallback when the primary is missing/empty (the plugin now reads it as a fallback).
- **agy v1.0.8 CLI has no output flag.** `agy --help`: only `--print/-p`, `--prompt`, `--continue/-c`, `--conversation <id>` (resume only), `--model`, `--print-timeout`, `--sandbox`, `--log-file`, `--add-dir`, `--dangerously-skip-permissions`, `-i`. No `--output`/`-o`, and `--log-file` only redirects Go diagnostic logs (no model answer). You cannot make agy write its answer to a chosen path.

Context: a full test plan + 8 characterization tests (pinning current buggy behavior on branch `claude/lucid-cori-778e96`) were produced; build/CI/README fixes live unapplied in git worktree `wf_7dc1b150-af6-7`.
