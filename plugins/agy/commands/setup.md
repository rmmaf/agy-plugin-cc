---
description: Check whether the local Antigravity CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
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

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Antigravity is installed but not authenticated, preserve the guidance to run `agy` once interactively to sign in with Google (on a headless or SSH machine it prints a URL and a one-time code to complete sign-in).
