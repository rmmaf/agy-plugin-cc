import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

function setupRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return repo;
}

function fakeEnv(behavior = "default") {
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  installFakeAgy(binDir);
  return { binDir, stateDir, env: buildEnv({ binDir, stateDir, behavior }) };
}

function enableGate(repo, env) {
  const enable = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(enable.status, 0, enable.stderr);
}

// Loop guard: when Claude Code re-runs the Stop hook because a prior invocation
// already blocked, it sets stop_hook_active. The hook must allow the stop
// immediately instead of spawning another BLOCK review, preventing an unbounded
// block->retry->block loop that drains usage.
test("stop-review gate allows the stop (no block) when stop_hook_active is true, even though agy is in BLOCK mode", () => {
  const repo = setupRepo();
  const { env } = fakeEnv("default"); // BLOCK behavior

  enableGate(repo, env);

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-test",
      cwd: repo,
      stop_hook_active: true,
      last_assistant_message: "I changed src/app.js to index into items directly."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "", "no decision payload should be emitted");
  assert.doesNotMatch(result.stdout, /"decision"\s*:\s*"block"/, "must not block on a re-entrant stop");
});

// Contrast: without stop_hook_active the gate must still block on BLOCK, so the
// loop guard does not silently disable the gate on a normal first Stop.
test("stop-review gate STILL blocks the stop when stop_hook_active is absent and agy returns BLOCK", () => {
  const repo = setupRepo();
  const { env } = fakeEnv("default"); // BLOCK behavior

  enableGate(repo, env);

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-test",
      cwd: repo,
      last_assistant_message: "I changed src/app.js to index into items directly."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Missing empty-state guard|still need fixes/i);
});
