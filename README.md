# agy plugin for Claude Code

Use agy from inside Claude Code for code reviews or to delegate tasks to agy.

This plugin is for Claude Code users who want an easy way to start using agy from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/agy:review` for a normal read-only agy review
- `/agy:adversarial-review` for a steerable challenge review
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` to delegate work and manage background jobs

## Requirements

- **A Google account.** The first `agy` run signs you in with Google. No separate API key is required.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/agy-plugin-cc
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
