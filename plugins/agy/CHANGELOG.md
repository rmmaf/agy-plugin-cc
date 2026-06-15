# Changelog

## 1.0.0

- Port of the Codex plugin to drive Google's Antigravity CLI (`agy`).
- Headless execution via `agy --print`, reading the model answer from agy's
  transcript files to work around the non-TTY stdout bug.
- Stop-time review gate wired through the `agy` runtime.
