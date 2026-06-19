---
description: Iteratively analyse an implementation plan with Antigravity and apply the changes you agree on
argument-hint: '[plan-file-path] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Edit, Glob, Grep, Bash(node:*), AskUserQuestion
---

Run a collaborative plan-analysis loop: Antigravity analyses the plan, you (Claude) review that analysis and decide what you agree and disagree with, you raise the disagreements with the user, and then optionally apply changes and re-analyse.

Raw slash-command arguments:
`$ARGUMENTS`

## Step 1 — Resolve and read the plan (Antigravity input)

- If `$ARGUMENTS` begins with a path to an existing file, treat that as the plan file. Any trailing text is extra focus for the analysis.
- Otherwise auto-detect the most recent plan file. Plan-mode plan files are stored under `~/.claude/plans/` on this machine; pick the newest with this cross-platform node one-liner (covered by `Bash(node:*)`):
```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.homedir(),'.claude','plans');let best=null;try{for(const f of fs.readdirSync(d)){if(!f.endsWith('.md'))continue;try{const t=fs.statSync(p.join(d,f)).mtimeMs;if(!best||t>best.t)best={f,t};}catch{}}}catch{}if(best)console.log(p.join(d,best.f));"
```
  If it prints nothing (none found) or your Claude Code version stores plans elsewhere, ask the user for the plan-file path before continuing.
- `Read` the plan file. Identify the files it names as affected and `Read`/`Grep` the relevant ones so you understand the current code.

## Step 2 — Antigravity analyses the plan

Run the analysis (Antigravity reads the affected files from the repository itself; pass extra focus text after the flags if useful):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" analyse-plan --plan-file "<resolved-plan-file-path>"
```
Capture the analysis output (Verdict, Agreements, Concerns, Recommended changes, Open questions).

## Step 3 — You review Antigravity's analysis

- Read Antigravity's analysis critically against the plan and the code you read.
- State explicitly, point by point, where you **agree** and where you **disagree** with Antigravity, with your reasoning. Do not just relay Antigravity's output — this is your own assessment.

## Step 4 — Raise disagreements with the user

- Report the points you agreed with as settled context.
- For the points where you and Antigravity disagree, use `AskUserQuestion` to ask the user how to resolve each material disagreement (one question per genuine fork, batched into a single `AskUserQuestion` call when possible).

## Step 5 — Decision 1: apply the changes?

- Use `AskUserQuestion` to ask whether to apply the agreed changes to the plan.
  - If **No** → stop here. Do not edit the plan.
  - If **Yes** → `Edit` the plan file, applying the changes you and the user agreed on. Do not apply changes that were rejected.

## Step 6 — Decision 2: analyse again?

- After applying changes, use `AskUserQuestion` to ask whether to run another analysis pass.
  - If **No** → stop. Summarize what changed.
  - If **Yes** → return to Step 1 using the now-updated plan file (same path) and repeat.

Constraints:
- This command only edits the plan file. Do not write code, run the plan, or touch other files.
- Preserve Antigravity's analysis faithfully when you present your review; clearly separate Antigravity's view from your own.
