---
description: Run an Antigravity deep-research pass on a topic and return the cited report
argument-hint: '[--intensity low|medium|high] [--wait|--background] [--save] <topic>'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion
---

Run an Antigravity deep-research pass and return the cited report verbatim.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is research-only.
- Do not act on, implement, or "improve" the findings.
- Your only job is to run the research and return Antigravity's output verbatim to the user.

Intensity:
- `--intensity low` is fast (≈3 min, 3-5 sources). `--intensity medium` is the default (≈8 min, 8-12 sources). `--intensity high` is exhaustive (≈20 min, 15+ sources).
- A `high` run can exceed Claude Code's foreground Bash timeout, so it must run in the background.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the research in the foreground.
- If the raw arguments include `--background`, do not ask. Run the research in a Claude background task.
- Otherwise recommend an execution mode by intensity:
  - For `--intensity low`, recommend waiting.
  - For `--intensity medium` (the default) or `--intensity high`, recommend background.
  - When in doubt, recommend background.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait`, `--background`, `--intensity`, or `--save` yourself.
- Do not rewrite the user's topic or add extra research instructions.
- Saving to the project knowledge base is controlled by `/agy:setup` (`--enable-save-research` / `--enable-save-reviewed-research`). The explicit `--save` flag forces saving for this run.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

Background flow:
- Launch the research with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research "$ARGUMENTS"`,
  description: "Antigravity research",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Antigravity research started in the background. Check `/agy:status` for progress and `/agy:result` for the report."

Note:
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- When `--enable-save-reviewed-research` is on, each run does two agy passes (research + verification), so a reviewed `high` run can take roughly twice as long — prefer background for it.
- Deep research needs live web access. If a run returns no sources, web search may be blocked by agy's sandbox — set `AGY_NO_SANDBOX=1` and retry, then run `agy` once interactively to confirm sign-in.
