---
description: Check whether the local Antigravity CLI is ready and optionally toggle the stop-time review gate and research options
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-save-research|--disable-save-research] [--enable-save-reviewed-research|--disable-save-reviewed-research] [--enable-research-before-plan|--disable-research-before-plan] [--enable-research-while-plan|--disable-research-while-plan]'
allowed-tools: Bash(node:*), Bash(curl:*), Bash(irm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

If the result says Antigravity is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Antigravity now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Antigravity (Recommended)`
  - `Skip for now`
- If the user chooses install, run the official installer for their platform.
  - On Windows (PowerShell):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

  - On macOS/Linux:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

If Antigravity is already installed:
- Do not ask about installation.

Research options (all default to disabled; pass the matching flag to toggle, persisted per repository):
- `--enable-save-research` / `--disable-save-research`: save `/agy:research` reports to the project knowledge base (`.claude/agy-knowledge-base/` + an auto-loading `agy-knowledge-base` index skill).
- `--enable-save-reviewed-research` / `--disable-save-reviewed-research`: like save-research, but run a second Antigravity verification pass to fact-check and correct the report before saving (roughly doubles latency and cost).
- `--enable-research-before-plan` / `--disable-research-before-plan`: have Claude run deep research on architecture, technologies, and domain background before producing an implementation plan.
- `--enable-research-while-plan` / `--disable-research-while-plan`: let Claude run deep research on sub-topics it judges important while planning.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Antigravity is installed but not authenticated, preserve the guidance to run `agy` once interactively to sign in with Google (on a headless or SSH machine it prints a URL and a one-time code to complete sign-in).
