# Memory Index

## Architecture map (complete plugin mapping — read overview first)
- [agy architecture overview](agy-architecture-overview.md) — ANCHOR: what the plugin is, the 3 core truths (legacy app-server naming = one-shot `agy --print` + transcript reading; broker is dormant; daemonless job model), full file inventory, import lineage, main flows, cross-cutting env/state facts
- [agy architecture: scripts/runtime](agy-architecture-scripts.md) — deep map of agy-companion.mjs (CLI router), lib/agy.mjs (runtime bridge + quirk handling), state/job layer, the 2 hooks, utility libs
- [agy architecture: broker subsystem](agy-architecture-broker.md) — the fully-built but DORMANT app-server/broker IPC (JSON-RPC, unix socket/named pipe, BROKER_BUSY); only the external agy CLI is its peer
- [agy architecture: declarative surface](agy-architecture-declarative.md) — 7 commands, agy:agy-rescue subagent, 3 skills, 2 prompt templates, review-output schema
- [agy architecture: tests/build/CI](agy-architecture-tests.md) — 11 node:test files, fake-agy-fixture (executable spec of the agy contract), bump-version, tsconfig, PR CI

## Runtime behavior
- [agy real runtime behavior](agy-real-runtime-behavior.md) — agy v1.0.8 quirks the plugin handles or depends on: tool-call turns producing empty answers, --write persisting edits despite raw binary failure, AGY_STATE_DIR ignored, concurrent threadId misattribution
