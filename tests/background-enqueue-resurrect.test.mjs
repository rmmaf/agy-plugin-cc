import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, initGitRepo } from "./helpers.mjs";

/*
 * F06 follow-up (resurrection race).
 *
 * enqueueBackgroundTask records the detached worker's pid AFTER spawning it.
 * Doing that by re-persisting the full "queued" record (status:"queued") would
 * clobber a fast worker that has already advanced the job to running/completed/
 * failed — resurrecting a finished/failed job back to "queued". The fix records
 * the pid ONLY while the job is still "queued", atomically (updateState under the
 * state lock), and never rewrites the job .json after spawn.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agy", "scripts", "agy-companion.mjs");

function withPluginData(pluginData, fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
    });
}

test("the post-spawn pid update does NOT resurrect a worker that already reached a terminal status", async () => {
  const pluginData = makeTempDir();
  const ws = makeTempDir();
  initGitRepo(ws);
  await withPluginData(pluginData, async () => {
    const { upsertJob, updateState, listJobs } = await import("../plugins/agy/scripts/lib/state.mjs");
    // The detached worker has already finished by the time the parent records pid.
    upsertJob(ws, { id: "jx", status: "completed", phase: "done", pid: null });
    // Mirror enqueueBackgroundTask's conditional pid write (only while queued).
    updateState(ws, (state) => {
      const e = state.jobs.find((j) => j.id === "jx");
      if (e && e.status === "queued") e.pid = 4242;
    });
    const job = listJobs(ws).find((j) => j.id === "jx");
    assert.equal(job.status, "completed", "a finished worker must not be resurrected to queued");
    assert.equal(job.pid ?? null, null, "no stale pid is written onto an already-terminal job");
  });
});

test("the post-spawn pid update DOES record the pid while the job is still queued", async () => {
  const pluginData = makeTempDir();
  const ws = makeTempDir();
  initGitRepo(ws);
  await withPluginData(pluginData, async () => {
    const { upsertJob, updateState, listJobs } = await import("../plugins/agy/scripts/lib/state.mjs");
    upsertJob(ws, { id: "jq", status: "queued", phase: "queued", pid: null });
    updateState(ws, (state) => {
      const e = state.jobs.find((j) => j.id === "jq");
      if (e && e.status === "queued") e.pid = 4242;
    });
    const job = listJobs(ws).find((j) => j.id === "jq");
    assert.equal(job.status, "queued");
    assert.equal(job.pid, 4242, "a still-queued job records the worker pid so cancel can reach it");
  });
});

test("enqueueBackgroundTask never re-persists the queued record after spawning the worker (source guard)", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("function enqueueBackgroundTask(");
  assert.ok(start >= 0, "enqueueBackgroundTask must exist");
  const end = src.indexOf("\nasync function ", start + 1);
  const body = end > start ? src.slice(start, end) : src.slice(start);

  const spawnIdx = body.indexOf("spawnDetachedTaskWorker(");
  assert.ok(spawnIdx >= 0, "must spawn the detached worker");
  const afterSpawn = body.slice(spawnIdx);

  assert.doesNotMatch(
    afterSpawn,
    /writeJobFile\s*\(/,
    "must NOT writeJobFile after spawn (would resurrect a finished worker via the .json)"
  );
  assert.doesNotMatch(
    afterSpawn,
    /queuedRecord/,
    "must NOT re-persist the full queued record after spawn (would resurrect a finished worker)"
  );
});
