import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { runAppServerTurn } from "../plugins/agy/scripts/lib/agy.mjs";

/*
 * F23/F24 FIX verification.
 *
 * Real agy v1.0.8: when a turn ends on tool calls / file edits, every final
 * MODEL/DONE/PLANNER_RESPONSE entry has EMPTY text. The plugin used to report
 * such a run as a FAILURE ("no readable answer", status 1) even though agy ran
 * and may have edited files (observed: a `--write` task whose edit persisted was
 * still reported as failed). The fix: a run is only failed when the process
 * failed OR no final MODEL entry was produced at all. An empty answer with a
 * final MODEL entry present is a SUCCESS (with an explanatory note).
 */

// Build a fake agy that writes a transcript and exits 0 silently (mimicking the
// non-TTY stdout bug). `mode` controls the final-entry shape:
//   - "toolcall": a final MODEL/DONE/PLANNER_RESPONSE entry WITH empty text
//   - "empty":    no final MODEL entry at all (only a USER echo)
function writeFakeAgy(binDir, mode) {
  const scriptPath = path.join(binDir, `fake-agy-${mode}.cjs`);
  const src = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("agy 0.0.0-fake\\n"); process.exit(0); }
const stateDir = process.env.AGY_STATE_DIR;
if (!stateDir) { process.stderr.write("fake agy: AGY_STATE_DIR not set\\n"); process.exit(3); }
const id = "00000000-0000-4000-8000-000000000abc";
const logDir = path.join(stateDir, "brain", id, ".system_generated", "logs");
fs.mkdirSync(logDir, { recursive: true });
const lines = [JSON.stringify({ source: "USER", status: "DONE", type: "USER_MESSAGE", text: "do the edit" })];
const MODE = ${JSON.stringify(mode)};
if (MODE === "toolcall") {
  // Final MODEL entry is PRESENT but carries no text (turn ended on tool calls).
  lines.push(JSON.stringify({ source: "MODEL", status: "DONE", type: "PLANNER_RESPONSE", id: "turn-" + id, text: "", tool_calls: 1 }));
}
fs.writeFileSync(path.join(logDir, "transcript.jsonl"), lines.join("\\n") + "\\n");
const cacheDir = path.join(stateDir, "cache");
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, "last_conversations.json"), JSON.stringify([{ id }]));
process.exit(0);
`;
  fs.writeFileSync(scriptPath, src);
  return scriptPath;
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

test("F23/F24: a tool-call-terminated turn (empty final text) is reported as SUCCESS, not failed", async () => {
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const fake = writeFakeAgy(binDir, "toolcall");

  await withEnv(
    { AGY_BIN: process.execPath, AGY_BIN_ARG: fake, AGY_STATE_DIR: stateDir, AGY_TIMEOUT_MS: "30000" },
    async () => {
      const repo = makeTempDir();
      const result = await runAppServerTurn(repo, { prompt: "make an edit", sandbox: "workspace-write" });

      assert.equal(
        result.status,
        0,
        `a tool-call-terminated run must be status 0; got ${result.status} / ${result.finalMessage}`
      );
      assert.equal(result.turn.status, "completed");
      assert.ok(result.threadId, "should correlate a conversation id");
      assert.match(result.finalMessage, /without a text answer|tool calls|file edits/i);
    }
  );
});

test("contrast: a transcript with NO final MODEL entry is still a failure", async () => {
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const fake = writeFakeAgy(binDir, "empty");

  await withEnv(
    { AGY_BIN: process.execPath, AGY_BIN_ARG: fake, AGY_STATE_DIR: stateDir, AGY_TIMEOUT_MS: "30000" },
    async () => {
      const repo = makeTempDir();
      const result = await runAppServerTurn(repo, { prompt: "do something" });

      assert.equal(result.status, 1, "no final MODEL entry => failure");
      assert.equal(result.turn.status, "failed");
    }
  );
});
