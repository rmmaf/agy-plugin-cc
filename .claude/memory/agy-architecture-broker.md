---
name: agy-architecture-broker
description: "Map of the agy plugin's app-server/broker IPC subsystem (app-server-broker.mjs, lib/app-server.mjs, broker-lifecycle.mjs, broker-endpoint.mjs, app-server-protocol.d.ts) — a fully-built JSON-RPC broker that is DORMANT in the plugin's own code path; only the external agy CLI is its RPC peer."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5522a8ac-b944-4844-a9d9-73189c3d84ed
---

# agy plugin — app-server / broker IPC subsystem

Child of [[agy-architecture-overview]]. **Read TRUTH #2 there first:** this subsystem is fully implemented but **dormant** — no JS file in the plugin issues `turn/start`/`thread/start`. `agy-companion.mjs`/`lib/agy.mjs` never reference the client. The real task/review path is one-shot `agy --print` + transcript reading ([[agy-architecture-scripts]]). The broker's intended purpose: let the *external* `agy` CLI (which reads `Antigravity_COMPANION_APP_SERVER_ENDPOINT`) share ONE upstream `Antigravity app-server` connection across many short invocations, with serialization. The plugin still owns the broker's lifecycle (SessionEnd teardown) even though it doesn't drive RPCs over it.

## Files
- **`app-server-broker.mjs` (252)** — the daemon. `node app-server-broker.mjs serve --endpoint <e> [--cwd] [--pid-file]`. Opens ONE upstream link via `AntigravityAppServerClient.connect(cwd, {disableBroker:true})` (avoids recursion), `net.createServer` listens on the endpoint path, multiplexes client sockets onto the single upstream. Answers `initialize` (`{userAgent:"Antigravity-companion-broker"}`) and `broker/shutdown` itself; forwards everything else. SIGTERM/SIGINT → graceful shutdown (end sockets, close upstream, unlink unix socket + pid file).
- **`lib/app-server.mjs` (350)** — JSON-RPC client engine. `AppServerClientBase` (monotonic id, pending map, newline-JSON framing, notification handler, rejects server-initiated requests with `-32601`). `SpawnedAntigravityAppServerClient` (transport `"direct"`: `spawn("Antigravity",["app-server"])`, `shell:true` on Windows, reads stdout via `readline`; `close()` uses `terminateProcessTree` on Windows because shell→cmd.exe interposes). `BrokerAntigravityAppServerClient` (transport `"broker"`: `net.createConnection({path})`). `AntigravityAppServerClient.connect` selects transport. Exports `BROKER_ENDPOINT_ENV="Antigravity_COMPANION_APP_SERVER_ENDPOINT"`, `BROKER_BUSY_RPC_CODE=-32001`.
- **`lib/broker-lifecycle.mjs` (209)** — spawn/discover/persist/teardown. `ensureBrokerSession` get-or-create (reuse if `broker.json` endpoint reachable in 150ms probe, else teardown stale + spawn fresh). `spawnBrokerProcess` is `detached:true, unref()`, stdio→logfile. Session file `<stateDir>/broker.json` = `{endpoint, pidFile, logFile, sessionDir, pid}`. Exports `PID_FILE_ENV`/`LOG_FILE_ENV`. `teardownBrokerSession` kills pid + unlinks files + rmdir session dir (all best-effort).
- **`lib/broker-endpoint.mjs` (41)** — `createBrokerEndpoint`: Windows → `pipe:\\.\pipe\<sanitized(basename)>-Antigravity-app-server`; else → `unix:<sessionDir>/broker.sock`. `parseBrokerEndpoint` → `{kind:"pipe"|"unix", path}` (path fed directly to `net`).
- **`lib/app-server-protocol.d.ts`** — type-only; re-exports generated types from `../../.generated/app-server-types/{index.js,v2/index.js}` (**not committed** — `tsc` survives via `skipLibCheck`). `AppServerMethodMap` = `initialize`, `thread/{start,resume,name/set,list}`, `review/start`, `turn/{start,interrupt}`.

## Protocol & lifecycle (quick facts)
- **Transport**: newline-delimited JSON (JSONL) over stdio (direct) or a unix socket / Windows named pipe (broker). No TCP. Messages: request `{id,method,params}`, response `{id,result}` / `{id,error:{code,message,data}}`, notification `{method,params}` (no id).
- **Handshake**: `initialize` (with `clientInfo`+`capabilities`, opts out of high-frequency delta notifications) then `initialized` notification.
- **Streaming methods**: `turn/start`, `review/start`, `thread/compact/start` — initial response then notifications until `turn/completed`.
- **Serialization / `BROKER_BUSY` (-32001)**: broker tracks ONE `activeRequestSocket` + ONE `activeStreamSocket`; a different socket's request while busy → `BROKER_BUSY` (no queue; client must back off). Exception: a cross-client `turn/interrupt` is allowed through during an active stream. Error codes: `-32700` invalid JSON, `-32601` unsupported server request, `-32000` generic upstream relay, `-32001` busy. `createProtocolError` copies `error.code`→`error.rpcCode` for caller detection.
- **Per-workspace, not per-session**: broker keyed off `resolveStateDir` (git repo). Multiple sessions in one repo share a broker — which is *why* BUSY serialization exists. Gotcha: one session's SessionEnd unconditionally tears down whatever `loadBrokerSession(cwd)` returns, so it can kill a broker another same-repo session is using.
- **No lock around `broker.json`** (unlike `state.json`) → two concurrent first-connects can both spawn; last `saveBrokerSession` wins, orphaning the first until teardown. 150ms readiness probe mitigates, doesn't eliminate.

## Only in-repo consumer
`session-lifecycle-hook.mjs` SessionEnd: `sendBrokerShutdown` (graceful) → `teardownBrokerSession({killProcess:terminateProcessTree})` (force) → `clearBrokerSession`. Both steps idempotent/best-effort (safe after clean shutdown). SessionStart does NOT start the broker (lazy creation on first `connect`, which the plugin currently never triggers from its own code).
