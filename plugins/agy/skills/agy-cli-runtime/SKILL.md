---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# agy Runtime

Use this skill only inside the `agy:agy-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "<raw arguments>"`

How the runtime works:
- `agy` runs as a one-shot headless CLI via `agy --print <prompt>`. There is no JSON-RPC "app server" and there are no protocol "threads".
- Because of a known upstream bug, `agy --print` writes nothing to stdout under a non-TTY. The companion therefore reads the model's answer from agy's transcript file at `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (the final entry with `source=MODEL`, `status=DONE`, `type=PLANNER_RESPONSE`).
- Resume uses agy's own `--conversation=<id>` / `--continue`, not protocol threads.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct agy CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `agy:agy-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter agy prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset. The `--effort` flag is accepted but currently ignored by the agy backend, so setting it has no effect.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one. Pass the model name verbatim; the available names can be listed with `agy models`.
- Default to a write-capable agy run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits. Note that `--write` maps to agy's workspace-write sandbox only when configured via the `AGY_SANDBOX_WRITE` env var.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` verbatim.
- If the forwarded request includes `--effort`, pass it through to `task`, but note it is currently a no-op on the agy backend.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable agy work in `agy:agy-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or agy cannot be invoked, return nothing.
