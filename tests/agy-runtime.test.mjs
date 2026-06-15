import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy, readFakeState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseStructuredOutput, runAppServerTurn, stripCodeFence } from "../plugins/agy/scripts/lib/agy.mjs";

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

test("setup reports ready with a direct CLI runtime and an honest (unverified) auth status", () => {
  const { stateDir, env } = fakeEnv();
  // Simulate a signed-in user by leaving an agy credential marker in the state dir.
  fs.writeFileSync(path.join(stateDir, "oauth_creds.json"), "{}\n");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
  assert.match(payload.sessionRuntime.label, /direct/i);
  assert.equal(payload.auth.loggedIn, true);
  // We must never claim a verified live session — only a best-effort local signal.
  assert.equal(payload.auth.verified, false);
});

test("setup surfaces sign-in guidance when no Antigravity credentials are detected", () => {
  const { env } = fakeEnv();
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true); // tooling is installed
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(
    payload.nextSteps.some((step) => /sign in/i.test(step) && /agy/.test(step)),
    "expected a sign-in next step when auth is unconfirmed"
  );
});

test("task succeeds, returns the transcript answer, and records a completed job (not failed)", () => {
  const repo = setupRepo();
  const { env } = fakeEnv();

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.status, "completed");
  assert.ok(report.latestFinished.threadId, "expected a captured conversation id");
});

test("task forwards --model verbatim without rewriting it to a fabricated alias", () => {
  const repo = setupRepo();
  const { binDir, env } = fakeEnv();

  const result = run("node", [SCRIPT, "task", "--model", "gemini-3-pro", "diagnose the bug"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastRun.model, "gemini-3-pro");
});

test("task --resume-last resumes the prior conversation by id", () => {
  const repo = setupRepo();
  const { binDir, env } = fakeEnv();

  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstConversation = readFakeState(binDir).lastConversationId;

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /Resumed the prior conversation|Follow-up handled/);

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastRun.conversation, firstConversation);
});

test("review runs the native reviewer and renders the transcript output", () => {
  const repo = setupRepo();
  const { env } = fakeEnv();

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Antigravity Review/);
  assert.match(result.stdout, /No material issues found in the reviewed changes/);
});

test("stop-review gate blocks the stop when agy returns BLOCK", () => {
  const repo = setupRepo();
  const { env } = fakeEnv("default");

  const enable = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(enable.status, 0, enable.stderr);

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

test("review enforces agy's --sandbox so a read-only review cannot modify files", () => {
  const repo = setupRepo();
  const { binDir, env } = fakeEnv();

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);

  const fakeState = readFakeState(binDir);
  assert.ok(fakeState.lastRun.argv.includes("--sandbox"), "review must run agy with --sandbox");
});

test("read-only tasks run under --sandbox; --write opts out and forwards write args", () => {
  const repo = setupRepo();

  const ro = fakeEnv();
  const roRun = run("node", [SCRIPT, "task", "investigate the bug"], { cwd: repo, env: ro.env });
  assert.equal(roRun.status, 0, roRun.stderr);
  assert.ok(readFakeState(ro.binDir).lastRun.argv.includes("--sandbox"), "read-only task must use --sandbox");

  const rw = fakeEnv();
  const rwEnv = { ...rw.env, AGY_SANDBOX_WRITE: "--dangerously-skip-permissions" };
  const rwRun = run("node", [SCRIPT, "task", "--write", "apply the fix"], { cwd: repo, env: rwEnv });
  assert.equal(rwRun.status, 0, rwRun.stderr);
  const rwArgv = readFakeState(rw.binDir).lastRun.argv;
  assert.ok(!rwArgv.includes("--sandbox"), "a --write task must not force the read-only sandbox");
  assert.ok(
    rwArgv.includes("--dangerously-skip-permissions"),
    "a --write task must forward the configured AGY_SANDBOX_WRITE args"
  );
});

test("stop-review gate allows the stop (no decision) when agy returns ALLOW", () => {
  const repo = setupRepo();
  const { env } = fakeEnv("stop-allow");

  const enable = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(enable.status, 0, enable.stderr);

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-test",
      cwd: repo,
      last_assistant_message: "I changed src/app.js."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

/* ------------------------------------------------------------------ *
 * parseStructuredOutput / stripCodeFence (fix #0: fenced JSON)
 * ------------------------------------------------------------------ */

test("parseStructuredOutput parses a ```json-fenced object and keeps the original raw output", () => {
  const raw = "```json\n{\"verdict\":\"BLOCK\",\"issues\":[\"x\"]}\n```";
  const result = parseStructuredOutput(raw);

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { verdict: "BLOCK", issues: ["x"] });
  // rawOutput must remain the ORIGINAL fenced text for display.
  assert.equal(result.rawOutput, raw);
  assert.ok(result.rawOutput.includes("```"), "raw output must preserve the markdown fence");
});

test("parseStructuredOutput parses a bare ``` fence and tolerates surrounding whitespace", () => {
  const bare = parseStructuredOutput("```\n{\"a\":1}\n```");
  assert.equal(bare.parseError, null);
  assert.deepEqual(bare.parsed, { a: 1 });

  const padded = parseStructuredOutput("\n\n  ```json\n  {\"b\":2}\n  ```  \n");
  assert.equal(padded.parseError, null);
  assert.deepEqual(padded.parsed, { b: 2 });
});

test("parseStructuredOutput still parses plain unfenced JSON", () => {
  const result = parseStructuredOutput("{\"ok\":true}");
  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { ok: true });
});

test("parseStructuredOutput yields parsed:null and a parseError for non-JSON", () => {
  const result = parseStructuredOutput("this is not json");
  assert.equal(result.parsed, null);
  assert.ok(result.parseError, "expected a parseError for non-JSON input");
  assert.equal(result.rawOutput, "this is not json");
});

test("stripCodeFence returns trimmed content for unfenced text", () => {
  assert.equal(stripCodeFence("  hello  "), "hello");
  assert.equal(stripCodeFence("```json\n{\"x\":1}\n```"), "{\"x\":1}");
});

/* ------------------------------------------------------------------ *
 * spawnAgy timeout (fix #3: never hang forever)
 * ------------------------------------------------------------------ */

test("runAppServerTurn fails fast (does not hang) when agy exceeds AGY_TIMEOUT_MS", async () => {
  const repo = setupRepo();
  const stateDir = makeTempDir();
  const binDir = makeTempDir();
  // A fake agy that never exits within the timeout: it just sleeps far longer
  // than the tiny AGY_TIMEOUT_MS we set below, simulating a stuck/blocked run.
  const slowScript = path.join(binDir, "slow-agy.cjs");
  fs.writeFileSync(slowScript, "setTimeout(() => {}, 60000);\n", "utf8");

  const previousEnv = {
    AGY_BIN: process.env.AGY_BIN,
    AGY_BIN_ARG: process.env.AGY_BIN_ARG,
    AGY_STATE_DIR: process.env.AGY_STATE_DIR,
    AGY_TIMEOUT_MS: process.env.AGY_TIMEOUT_MS
  };
  process.env.AGY_BIN = process.execPath;
  process.env.AGY_BIN_ARG = slowScript;
  process.env.AGY_STATE_DIR = stateDir;
  process.env.AGY_TIMEOUT_MS = "300";

  try {
    const started = Date.now();
    const result = await runAppServerTurn(repo, { prompt: "do something slow" });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 1, "a timed-out run must report failure status 1");
    assert.match(result.finalMessage, /timed out after 300 ms/i);
    assert.match(result.finalMessage, /AGY_TIMEOUT_MS/);
    assert.equal(result.threadId, null, "a timed-out run must not correlate a conversation id");
    // It must return well before the child's 60s sleep would have completed.
    assert.ok(elapsed < 10000, `expected fast failure, took ${elapsed}ms`);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
