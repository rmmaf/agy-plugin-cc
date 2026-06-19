---
description: Build or extend the project knowledge base by researching gaps with Antigravity
argument-hint: '[research topic]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion
---

Build or extend this project's knowledge base. Research always saves: each run writes a report to `.claude/agy-knowledge-base/<slug>.md` and regenerates the auto-loading `agy-knowledge-base` index skill.

Raw slash-command arguments:
`$ARGUMENTS`

## If arguments are provided (a specific topic)

Run the research for that topic and force-save it to the knowledge base:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research --save "$ARGUMENTS"
```
- Return the command stdout verbatim. The companion writes the knowledge-base entry and updates the index skill automatically.
- For a long or broad topic, prefer launching it with `Bash(..., run_in_background: true)` and tell the user to check `/agy:status`.

## If no arguments are provided (gap analysis)

Figure out what the knowledge base is missing, then research the gaps. Do this work yourself before calling Antigravity:

1. **Inventory the existing knowledge base.** `Glob` `.claude/agy-knowledge-base/*.md` and `Read` the frontmatter `title`/`topic` of each entry. These topics are already covered — do not re-research them unless they look stale.
2. **Analyze the project.** Use `Glob`/`Grep`/`Read` on package manifests (e.g. `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`), the README, and the top-level source layout to infer the domain, the languages/frameworks in use, and the architecture.
3. **Consult saved memories** if available (best-effort; the path is machine-specific, so do not hardcode it — skip silently if you cannot find it). Use them to avoid re-researching what is already known.
4. **Propose 3–6 candidate research topics** that fill real gaps, grouped along these angles:
   - architectural approaches for the project's core problems, simplest to state-of-the-art;
   - relevant technologies (libraries, frameworks, services) with alternatives and trade-offs;
   - domain/background knowledge for the project's field.
5. **Confirm with the user.** Use `AskUserQuestion` once (multi-select) to let the user keep or drop candidate topics before spending research time.
6. **Research each confirmed topic.** For every topic, run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research --save "<topic>"
```
   Run them one at a time in the foreground for a small set, or launch them with `Bash(..., run_in_background: true)` and point the user at `/agy:status` for a larger set.
7. **Summarize** which entries were added or refreshed, and remind the user that the `agy-knowledge-base` skill may need a Claude Code restart (or `/reload-plugins`) the first time it is created.

Constraints:
- Do not fabricate knowledge-base content yourself — Antigravity produces the reports; you only decide the topics and forward them.
- Preserve each `research` command's stdout when you report back.
