import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, resolveJobLogFile, resolveJobsDir, resolveStateDir, resolveStateFile, saveState, setConfig, upsertJob, writeJobFile } from "../plugins/agy/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  // Ensure the tmpdir fallback is exercised even when the ambient environment
  // already exports CLAUDE_PLUGIN_DATA.
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState writes JSON atomically and leaves no temp file behind", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);

  const written = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [{ id: "job-atomic", status: "completed" }]
  });

  // Round-trip: what we read back must equal what saveState reports it wrote.
  const readBack = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(readBack, written);
  assert.equal(readBack.config.stopReviewGate, true);
  assert.equal(readBack.jobs.length, 1);
  assert.equal(readBack.jobs[0].id, "job-atomic");

  // The atomic write must not leave a ".tmp" sidecar in the state dir.
  const stateDir = path.dirname(stateFile);
  const leftoverStateTemps = fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftoverStateTemps, []);
});

test("writeJobFile writes JSON atomically and leaves no temp file behind", () => {
  const workspace = makeTempDir();

  const jobFile = writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "running" });

  // Round-trip through the public reader.
  assert.deepEqual(readJobFile(jobFile), { id: "job-atomic", status: "running" });

  const jobsDir = resolveJobsDir(workspace);
  const leftoverJobTemps = fs.readdirSync(jobsDir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftoverJobTemps, []);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("mutating calls release the cross-process lock and leave no .state.lock behind", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, ".state.lock");

  // Exercise each lock-guarded mutating entry point.
  setConfig(workspace, "stopReviewGate", true);
  upsertJob(workspace, { id: "job-lock", status: "running" });
  upsertJob(workspace, { id: "job-lock", status: "completed" });
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });

  // The mutations must have actually applied (correctness under the lock).
  assert.equal(getConfig(workspace).stopReviewGate, false);
  assert.deepEqual(listJobs(workspace), []);

  // The happy path must never leave a stale lock directory behind.
  assert.equal(fs.existsSync(lockDir), false, "the .state.lock dir must be released after each mutation");
});

test("withStateLock degrades without deadlocking when the lock dir is pre-held", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, ".state.lock");

  // Pre-create the lock dir to simulate another live holder. The lock budget is
  // ~2s, so the call must return shortly after that WITHOUT hanging — it
  // degrades to last-writer-wins rather than blocking forever.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(lockDir);

  const started = Date.now();
  const result = setConfig(workspace, "stopReviewGate", true);
  const elapsed = Date.now() - started;

  // The mutation still succeeds (degraded, lock-free).
  assert.equal(result.config.stopReviewGate, true);
  // It must give up well within a few seconds, never deadlock.
  assert.ok(elapsed < 5000, `expected lock acquisition to give up quickly, took ${elapsed}ms`);
  // Our caller did NOT own the pre-held lock, so it must not remove it.
  assert.equal(fs.existsSync(lockDir), true, "a degraded caller must not delete a lock it never held");

  // Cleanup the simulated holder's lock.
  fs.rmdirSync(lockDir);
});
