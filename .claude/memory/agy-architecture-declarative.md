---
name: agy-architecture-declarative
description: "Map of the agy plugin's user-facing declarative surface — the 7 slash commands, the agy:agy-rescue subagent, the 3 skills (+references), the 2 prompt templates, and review-output.schema.json. What Claude Code loads to expose the plugin and the prompting/result contracts it enforces."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5522a8ac-b944-4844-a9d9-73189c3d84ed
---

# agy plugin — declarative / user-facing surface

Child of [[agy-architecture-overview]]. The markdown+JSON that Claude Code loads. Everything routes to `scripts/agy-companion.mjs` ([[agy-architecture-scripts]]).

## Commands (`plugins/agy/commands/*.md`)
All invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" <sub>`. Six set `disable-model-invocation:true` (all except `setup`). None pins a `model:`.

| Command | Invokes | Notes |
|---|---|---|
| `/agy:setup` | `setup --json $ARGUMENTS` | Only command with real orchestration. If agy missing, `AskUserQuestion` once → install via official `antigravity.google/cli/install.(ps1\|sh)`, rerun. If installed-unauth, tell user to run `agy` once (Google sign-in). allowed-tools incl. `Bash(curl:*)`, `Bash(irm:*)`, `AskUserQuestion`. |
| `/agy:review` | `review "$ARGUMENTS"` | **Native review only** — rejects focus text, staged-only, unstaged-only. Sizes diff via `git status/diff --shortstat`, asks `Wait`/`Background` once. Review-only: never fixes; returns stdout verbatim. |
| `/agy:adversarial-review` | `adversarial-review "$ARGUMENTS"` | Challenge review (questions approach/design/tradeoffs); **accepts trailing focus text**; same sizing/ask logic. |
| `/agy:status` | `status "$ARGUMENTS"` | No id → compact markdown table; with id → full detail. |
| `/agy:result` | `result "$ARGUMENTS"` | Full payload unsummarized; preserve job id, findings, paths/lines. |
| `/agy:cancel` | `cancel "$ARGUMENTS"` | Cancel active job. |
| `/agy:rescue` | delegates to subagent | allowed-tools `Bash(node:*), AskUserQuestion, Agent`. Orchestrates the rescue subagent (below). |

`--wait`/`--background` on review commands are Claude-side execution flags — actual backgrounding is Claude's `Bash(run_in_background:true)`, NOT the script's flags.

## `/agy:rescue` orchestration + `agents/agy-rescue.md` subagent
- `/agy:rescue` invokes `Agent` with `subagent_type:"agy:agy-rescue"`, forwarding the request. **CRITICAL/regression-locked**: must NOT call `Skill(agy:agy-rescue)` (no such skill) or `Skill(agy:rescue)` (re-enters the command, hangs). Must run inline (not `context:fork`) so the `Agent` tool stays in scope (regression #234). Resume routing: `--resume`→continue, `--fresh`→new; if neither, run `task-resume-candidate --json` and `AskUserQuestion` once if a candidate exists.
- **Subagent** `agy-rescue`: `model: sonnet`, `tools: Bash` only, auto-loads skills `agy:agy-cli-runtime` + `agy:gpt-5-4-prompting`. A **thin forwarder**: exactly ONE Bash call `agy-companion.mjs task ...`, returns stdout verbatim, returns NOTHING on failure. Must NOT inspect repo / poll status / fetch results / cancel / summarize, and must NOT call review/adversarial-review/status/result/cancel — **only `task`**. Flag mapping: `--resume`→`--resume-last`, `--fresh`→fresh; `--background`/`--wait` stripped (Claude-side); `--model` passed verbatim (no alias map — old `spark` removed), unset by default; `--effort` left unset (**accepted but ignored by backend**); **defaults to `--write`** unless user wants read-only/review/diagnosis.

## Skills (`plugins/agy/skills/`, all `user-invocable:false`)
- **`agy-cli-runtime`** — the runtime contract. Documents the real model (one-shot `agy --print`, NO JSON-RPC/threads; reads answer from `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`; `transcript_full.jsonl` fallback; bounded settle re-read tunable via `AGY_TRANSCRIPT_SETTLE_MS`; every result persisted to `answers/<id>.json` as `answerFile`; `diagnostic:"auth-or-incomplete"` when no transcript; resume via `--conversation`/`--continue`). Plus the forwarder/safety rules mirrored in the subagent.
- **`agy-result-handling`** — how to present output: findings first by severity, exact file:line, preserve facts/inference/uncertainty boundaries. **CRITICAL rule: after presenting review findings, STOP — make no edits; explicitly ASK which to fix.** Don't turn a failed/incomplete agy run into a Claude-side implementation; on `auth-or-incomplete` direct to `/agy:setup` (don't fabricate; full answer is at `answerFile`).
- **`gpt-5-4-prompting`** — how to compose agy prompts: "operator not collaborator", compact XML-tagged blocks, one task per run, state the output contract + follow-through. References: `prompt-blocks.md` (reusable `<task>`, `<structured_output_contract>`, `<compact_output_contract>`, `<default_follow_through_policy>`, `<completeness_contract>`, `<verification_loop>`, `<missing_context_gating>`, `<grounding_rules>`, `<citation_rules>`, `<action_safety>`, `<research_mode>`, `<dig_deeper_nudge>`), `agy-prompt-recipes.md` (5 templates: Diagnosis, Narrow Fix, Root-Cause Review, Research, Prompt-Patching — diagnosis/fix run in write mode by default), `agy-prompt-antipatterns.md` (6 bad→better contrasts).

## Prompt templates (`plugins/agy/prompts/`, interpolated by scripts)
- **`adversarial-review.md`** — interpolated by the adversarial-review path. Placeholders `{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{REVIEW_INPUT}}`. Skeptical reviewer: "break confidence in the change, not validate it"; risk areas (access/permission, data loss, rollback/retry/idempotency, races, empty-state/timeout/degraded deps, version skew/migration, observability); `<structured_output_contract>` = **emit ONLY valid JSON matching `review-output.schema.json`**; grounding/calibration/final-check blocks.
- **`stop-review-gate.md`** — interpolated by the Stop hook. Placeholder `{{CLAUDE_RESPONSE_BLOCK}}`. Review ONLY the previous turn, and ONLY if it made direct code edits (status/setup output → ALLOW immediately). **First line must be exactly `ALLOW: <reason>` or `BLOCK: <reason>`.** Line 2 of the file is the literal `STOP_REVIEW_TASK_MARKER`.

## `schemas/review-output.schema.json` (JSON Schema 2020-12)
Adversarial-review output contract. Top level (`additionalProperties:false`, all required): `verdict` (enum `approve`|`needs-attention`), `summary` (string minLength 1), `findings` (array, no minItems — empty + `approve` is valid), `next_steps` (array of non-empty strings). **Finding** (all 8 required, `additionalProperties:false`): `severity` (enum `critical`|`high`|`medium`|`low`), `title`, `body`, `file` (all minLength 1), `line_start`/`line_end` (integer ≥1), `confidence` (number 0–1), `recommendation` (the only required field without minLength).

## Intent (README/CHANGELOG)
Drive the user's local `agy` install (Google account, no API key; Node ≥18.18) from Claude Code for reviews + task delegation. Install: `/plugin marketplace add rmmaf/agy-plugin-cc` → `/plugin install agy@agy` → `/reload-plugins` → `/agy:setup`. Single CHANGELOG entry (1.0.0): port of the Codex plugin; headless `agy --print` + transcript reading; stop-time review gate. Documented: `--effort` accepted-but-ignored; `--write` maps to agy workspace-write only via `AGY_SANDBOX_WRITE`; `--model` verbatim (`agy models` lists names); resume via `agy --continue`/`--conversation=<id>`; review gate can create a long agy/Claude loop (enable only when monitoring).
