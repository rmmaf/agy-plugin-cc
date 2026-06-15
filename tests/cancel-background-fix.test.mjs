import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeAgy, buildEnv } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

/*
 * LANE F05/F06 — regression tests asserting the CORRECT (post-fix) behavior.
 *
 * FIX F05 (handleCancel, agy-companion.mjs): terminateProcessTree is wrapped in
 *   try/catch BEFORE the cancelled state is written. On Windows an unrecognized
 *   taskkill failure (e.g. "Access is denied." for the System pid 4) makes
 *   terminateProcessTree THROW. Cancel must survive that throw, log a best-effort
 *   note, and STILL mark the job "cancelled" (exit 0).
 *
 * FIX F06a (enqueueBackgroundTask): the request-bearing job .json is persisted
 *   BEFORE the detached worker is spawned, so the worker can never observe a
 *   request-less / absent job file. After `task --background` the job .json must
 *   already exist and carry a `request`.
 *
 * FIX F06b (handleTaskWorker): if the stored job is missing OR has no `request`,
 *   the worker marks the job FAILED (never leaves it stuck "queued") before
 *   exiting non-zero, so a bad enqueue surfaces as "failed".
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agy", "scripts", "agy-companion.mjs");

function fakeEnv(behavior = "default") {
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  const pluginData = makeTempDir();
  installFakeAgy(binDir);
  const env = { ...buildEnv({ binDir, stateDir, behavior }), CLAUDE_PLUGIN_DATA: pluginData };
  return { binDir, stateDir, pluginData, env };
}

// Resolve the companion's jobs dir for a repo using the SAME hashing the runtime
// uses, under our isolated CLAUDE_PLUGIN_DATA.
async function resolveJobsDirFor(repo, pluginData) {
  const { resolveJobsDir } = await import("../plugins/agy/scripts/lib/state.mjs");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return resolveJobsDir(repo);
  } finally {
    if (prev === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = prev;
    }
  }
}

function setupRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function jobIdFromLaunch(stdout) {
  const m = (stdout || "").match(/task-[a-z0-9-]+/);
  assert.ok(m, `expected a job id in launch output, got: ${JSON.stringify(stdout)}`);
  return m[0];
}

// An unkillable system pid whose kill is denied (not "missing"), so
// terminateProcessTree THROWS: System (4) on Windows, init (1) on POSIX.
const UNKILLABLE_PID = process.platform === "win32" ? 4 : 1;

test("F05: cancel survives a kill failure and still marks the job cancelled (exit 0)", async () => {
  const repo = setupRepo();
  const { env, pluginData } = fakeEnv();

  // Materialize a stored RUNNING job whose pid is unkillable, plus the matching
  // jobs-index entry so resolveCancelableJob can find it.
  const jobsDir = await resolveJobsDirFor(repo, pluginData);
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = "task-unkillable-001";
  const logFile = path.join(jobsDir, `${jobId}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  const storedJob = {
    id: jobId,
    title: "Antigravity Task",
    summary: "unkillable running job",
    workspaceRoot: repo,
    jobClass: "task",
    kind: "task",
    status: "running",
    phase: "running",
    pid: UNKILLABLE_PID,
    logFile
  };
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), `${JSON.stringify(storedJob, null, 2)}\n`);

  const stateFile = path.join(path.dirname(jobsDir), "state.json");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [storedJob] }, null, 2)}\n`
  );

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json", "--cwd", repo], { cwd: repo, env });

  // Cancel must NOT crash because the kill failed.
  assert.equal(cancel.status, 0, `cancel must survive a kill failure; stderr: ${cancel.stderr}`);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled", "job must be reported cancelled");

  // And the persisted job .json must reflect the cancelled state.
  const after = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
  assert.equal(after.status, "cancelled", "stored job must be marked cancelled after a kill failure");
});

test("F06a: task --background persists a request-bearing job .json before the worker runs", async () => {
  const repo = setupRepo();
  const { env, pluginData } = fakeEnv();

  const enqueue = run("node", [SCRIPT, "task", "--background", "do the work"], { cwd: repo, env });
  assert.equal(enqueue.status, 0, enqueue.stderr);
  const jobId = jobIdFromLaunch(enqueue.stdout);

  const jobsDir = await resolveJobsDirFor(repo, pluginData);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  assert.ok(fs.existsSync(jobFile), `job file should exist at ${jobFile}`);

  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.ok(
    job.request && typeof job.request === "object",
    "the enqueued job .json must carry a `request` payload so the worker can never observe a request-less file"
  );
  assert.equal(job.request.prompt, "do the work", "the stored request must carry the task prompt");
});

test("F06b: a request-less stored job is marked FAILED by the worker, not left stuck queued", async () => {
  const repo = setupRepo();
  const { env, pluginData } = fakeEnv();

  const enqueue = run("node", [SCRIPT, "task", "--background", "do the work"], { cwd: repo, env });
  assert.equal(enqueue.status, 0, enqueue.stderr);
  const jobId = jobIdFromLaunch(enqueue.stdout);

  const jobsDir = await resolveJobsDirFor(repo, pluginData);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  assert.ok(fs.existsSync(jobFile), `job file should exist at ${jobFile}`);

  // Blank the stored `request` and force the job back to "queued" to reproduce a
  // bad enqueue exactly.
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  delete job.request;
  job.status = "queued";
  job.phase = "queued";
  fs.writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);

  const worker = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env
  });

  // The worker still exits non-zero (the bad enqueue is a real error) ...
  assert.notEqual(worker.status, 0, "worker should exit non-zero on a missing request payload");

  // ... but it must mark the job FAILED before exiting, never leave it stuck.
  const after = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(
    after.status,
    "failed",
    "a request-less job must be marked 'failed' by the worker, not left stuck 'queued'"
  );
  assert.equal(after.phase, "failed", "the failed job's phase must be 'failed'");
});
