# Changelog

## 1.1.0

- Add `/agy:research` — a deep web-research pass via the agy runtime that returns
  a cited report (`--intensity low|medium|high`, `--wait`/`--background`, `--save`).
- Add a project knowledge base: when saving is enabled, research reports persist
  to `.claude/agy-knowledge-base/<slug>.md` and an auto-loading
  `agy-knowledge-base` index skill is regenerated.
- Add `/agy:generate-knowledge-base` — research a specific topic, or analyze the
  project and saved memories to research the gaps and build out the knowledge base.
- Add `/agy:analyse-plan` — an iterative loop where agy analyses an implementation
  plan, Claude reviews that analysis with you, and agreed changes are applied.
- Add `/agy:setup` flags: `--enable-save-research`, `--enable-save-reviewed-research`
  (adds a second agy verification pass before saving), `--enable-research-before-plan`,
  and `--enable-research-while-plan` (each with a matching `--disable-*`).
- Add a `UserPromptSubmit` hook that injects planning-research guidance (once per
  session, fail-open) when the before/while-plan flags are enabled.

## 1.0.0

- Port of the Codex plugin to drive Google's Antigravity CLI (`agy`).
- Headless execution via `agy --print`, reading the model answer from agy's
  transcript files to work around the non-TTY stdout bug.
- Stop-time review gate wired through the `agy` runtime.
