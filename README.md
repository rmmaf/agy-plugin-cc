# agy plugin for Claude Code

Use agy from inside Claude Code for code reviews or to delegate tasks to agy.

This plugin is for Claude Code users who want an easy way to start using agy from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/agy:review` for a normal read-only agy review
- `/agy:adversarial-review` for a steerable challenge review
- `/agy:research` for a cited deep-research pass, with an optional project knowledge base
- `/agy:generate-knowledge-base` to research gaps and build the project knowledge base
- `/agy:analyse-plan` to have agy critique an implementation plan in a review loop
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` to delegate work and manage background jobs

## Requirements

- **A Google account.** The first `agy` run signs you in with Google. No separate API key is required.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add rmmaf/agy-plugin-cc
```

Install the plugin:

```bash
/plugin install agy@agy
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/agy:setup
```

`/agy:setup` will tell you whether agy is ready. If agy is missing, it can point you at the install command.

If you prefer to install agy yourself:

- Windows: `irm https://antigravity.google/cli/install.ps1 | iex`
- macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`

If agy is installed but not signed in yet, run `agy` once interactively to complete the Google sign-in (in a headless environment it prints a URL and a one-time code to authorize).

After install, you should see:

- the slash commands listed below
- the `agy:agy-rescue` subagent in `/agents`

One simple first run is:

```bash
/agy:review --background
/agy:status
/agy:result
```

## Usage

### `/agy:review`

Runs a normal agy review on your current work. It gives you the same quality of code review as running `/review` inside agy directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/agy:adversarial-review`](#agyadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/agy:review
/agy:review --base main
/agy:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/agy:status`](#agystatus) to check on the progress and [`/agy:cancel`](#agycancel) to cancel the ongoing task.

### `/agy:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/agy:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/agy:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/agy:adversarial-review
/agy:adversarial-review --base main challenge whether this was the right caching and retry design
/agy:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/agy:research`

Runs a deep web-research pass with agy and returns a cited Markdown report (TL;DR, observed facts, analysis, recommendation, open questions, references).

Pick the depth with `--intensity`:

- `low` — fast, 3–5 sources
- `medium` — the default, 8–12 sources
- `high` — exhaustive, 15+ sources (run it in the background; it can take ~20 minutes)

It also supports `--wait`/`--background` and `--save` (force-save this run to the knowledge base).

```bash
/agy:research what are the current best practices for OAuth2 PKCE in SPAs
/agy:research --intensity high --background compare vector databases for RAG
```

Saving to the knowledge base is off by default; enable it with `/agy:setup --enable-save-research` (or `--enable-save-reviewed-research` to fact-check first). Deep research needs live web access — if a run returns no sources, see [Common Configurations](#common-configurations) about the sandbox.

### `/agy:generate-knowledge-base`

Builds or extends a project knowledge base under `.claude/agy-knowledge-base/`, plus an auto-loading `agy-knowledge-base` skill that future sessions can consult.

- With a topic, it researches that topic and saves it.
- With no arguments, Claude inventories the existing knowledge base, analyzes the project and your saved memories, proposes topics that fill the gaps (architecture approaches, relevant technologies, domain background), confirms them with you, and researches each.

```bash
/agy:generate-knowledge-base
/agy:generate-knowledge-base the payment-provider APIs this project integrates with
```

The first time the knowledge-base skill is created you may need to restart Claude Code (or `/reload-plugins`) for it to load.

### `/agy:analyse-plan`

Runs an iterative plan-review loop: agy analyses an implementation plan against the affected code, you (Claude) review that analysis and surface the disagreements, and — if you choose — the agreed changes are applied to the plan before optionally analysing again.

By default it auto-detects the most recent plan file under `~/.claude/plans/`; pass a path to analyse a specific file.

```bash
/agy:analyse-plan
/agy:analyse-plan ./docs/refactor-plan.md focus on migration safety
```

This command only edits the plan file. It does not write code.

### `/agy:rescue`

Hands a task to agy through the `agy:agy-rescue` subagent.

Use it when you want agy to:

- investigate a bug
- try a fix
- continue a previous agy task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/agy:rescue investigate why the tests started failing
/agy:rescue fix the failing test with the smallest safe patch
/agy:rescue --resume apply the top fix from the last run
/agy:rescue --model <name> investigate the flaky integration test
/agy:rescue --background investigate the regression
```

List the model names you can pass to `--model` with `agy models`.

You can also just ask for a task to be delegated to agy:

```text
Ask agy to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, agy chooses its own default.
- the `--effort` flag is accepted but currently ignored by the agy backend, so it has no effect today.
- follow-up rescue requests can continue the latest agy task in the repo

### `/agy:status`

Shows running and recent agy jobs for the current repository.

Examples:

```bash
/agy:status
/agy:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/agy:result`

Shows the final stored agy output for a finished job.
When available, it also includes the agy conversation ID so you can reopen that run directly in agy with `agy --continue` or `agy --conversation=<id>`.

Examples:

```bash
/agy:result
/agy:result task-abc123
```

### `/agy:cancel`

Cancels an active background agy job.

Examples:

```bash
/agy:cancel
/agy:cancel task-abc123
```

### `/agy:setup`

Checks whether agy is installed and authenticated.
If agy is missing, it can point you at the install command for your platform.

You can also use `/agy:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted agy review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/agy loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

#### Research options

`/agy:setup` also toggles the research options (all off by default, persisted per repository):

```bash
/agy:setup --enable-save-research           # persist /agy:research reports to the knowledge base
/agy:setup --enable-save-reviewed-research  # like above, but fact-check with a second agy pass first
/agy:setup --enable-research-before-plan    # research architecture/tech/domain before planning
/agy:setup --enable-research-while-plan     # research sub-topics on demand while planning
```

Each has a matching `--disable-*`. `--enable-save-reviewed-research` runs a second agy verification pass before saving, which roughly doubles research latency and cost. When the before/while-plan options are on, a `UserPromptSubmit` hook reminds Claude (once per session) to run `/agy:research` around planning.

## Typical Flows

### Review Before Shipping

```bash
/agy:review
```

### Hand A Problem To agy

```bash
/agy:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/agy:adversarial-review --background
/agy:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agy:status
/agy:result
```

## agy Integration

The agy plugin drives the global `agy` binary installed in your environment. It runs agy as a one-shot headless CLI (`agy --print <prompt>`) and reads the model's answer from agy's transcript file, then applies your existing agy configuration. See the [Antigravity docs](https://antigravity.google/docs) for more.

### Common Configurations

You can change the default model the plugin uses per run by passing `--model <name>`. List the available model names with `agy models`. The plugin also picks up whatever agy configuration you already have on the machine.

Note that the `--effort` (reasoning effort) flag is accepted but currently ignored by the agy backend, so it has no effect today.

The `--write` flag maps to agy's workspace-write sandbox only when that is configured via the `AGY_SANDBOX_WRITE` environment variable.

Read-only runs (reviews and `/agy:research`) enforce agy's `--sandbox`. If `/agy:research` returns no web sources, your agy/sandbox combination may be blocking web access — set `AGY_NO_SANDBOX=1` and retry, and run `agy` once interactively to confirm you are signed in.

Check out the [Antigravity docs](https://antigravity.google/docs) for more configuration options.

### Moving The Work Over To agy

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be resumed inside agy by running `agy --continue`, or `agy --conversation=<id>` with the conversation ID you received from `/agy:result` or `/agy:status`.

This way you can review the agy work or continue the work there.

## FAQ

### Do I need a separate agy account for this plugin?

If you are already signed into agy on this machine, that account should work immediately here too. This plugin uses your local agy CLI authentication.

If you only use Claude Code today and have not used agy yet, run `agy` once interactively to complete the Google sign-in (in a headless environment it prints a URL and a one-time code to authorize). Run `/agy:setup` to check whether agy is ready.

### Does the plugin use a separate agy runtime?

No. This plugin delegates through your local agy CLI on the same machine. It runs agy as a one-shot headless command (`agy --print <prompt>`) rather than a long-lived service.

That means:

- it uses the same agy install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same agy config I already have?

Yes. If you already use agy, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current sign-in?

Yes. Because the plugin uses your local agy CLI, your existing Google sign-in and config still apply.
