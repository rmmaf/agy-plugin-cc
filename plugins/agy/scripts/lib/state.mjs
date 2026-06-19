import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "Antigravity-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const ANSWERS_DIR_NAME = "answers";
const LOCK_DIR_NAME = ".state.lock";
const MAX_JOBS = 50;

// Cross-process lock tuning. The lock is BEST EFFORT and MUST NEVER hang or
// deadlock: if it cannot be acquired within the budget we proceed without it
// (degrading to today's last-writer-wins) rather than blocking or throwing.
const LOCK_RETRY_MS = 25; // backoff between acquisition attempts
const LOCK_TOTAL_BUDGET_MS = 2000; // give up acquiring after ~2s
const LOCK_STALE_MS = 10000; // a lock dir older than this is presumed abandoned

let atomicWriteCounter = 0;

/**
 * Atomically write `contents` to `target` by writing to a uniquely named
 * temporary file on the same directory/volume and then renaming over the
 * target. `fs.renameSync` is atomic on the same volume on both Windows and
 * POSIX, so concurrent writers can never observe a torn/partial file
 * (last-writer-wins). The temp name includes the pid and a monotonic counter
 * so two writers never collide on the temp file itself. The temp file is
 * cleaned up on a best-effort basis if the write or rename fails.
 */
export function atomicWriteFileSync(target, contents) {
  atomicWriteCounter += 1;
  const tmp = `${target}.${process.pid}.${atomicWriteCounter}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch {
      // Best-effort cleanup; ignore failures removing the temp file.
    }
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      saveResearch: false,
      saveReviewedResearch: false,
      researchBeforePlan: false,
      researchWhilePlan: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function resolveAnswersDir(cwd) {
  return path.join(resolveStateDir(cwd), ANSWERS_DIR_NAME);
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Synchronous, CPU-friendly sleep used for lock backoff. Atomics.wait blocks the
// thread on an unshared int32 buffer that is never notified, so it simply times
// out after `ms`. Falls back to a bounded busy-wait if Atomics is unavailable.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback
    }
  }
}

function lockDirFor(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
}

/**
 * Run `fn` while holding a best-effort cross-process lock for `cwd`'s state dir.
 *
 * The lock is a directory created with `fs.mkdirSync` — directory creation is
 * atomic on both POSIX and Windows, so EEXIST unambiguously means another
 * process (or another in-process caller) holds it. We retry with a short
 * backoff up to a bounded total budget, and break a STALE lock (older than
 * LOCK_STALE_MS) so a crashed holder can't wedge everyone forever.
 *
 * CRITICAL: this never hangs or deadlocks. If the budget is exhausted we run
 * `fn` WITHOUT the lock (degrading to last-writer-wins) rather than blocking or
 * throwing. The lock is ALWAYS released in `finally` on the happy path, so no
 * stale `.state.lock` dir is left behind under normal operation.
 */
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockDir = lockDirFor(cwd);
  const deadline = Date.now() + LOCK_TOTAL_BUDGET_MS;
  let held = false;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // Any other error (e.g. permissions): don't block writes — degrade to
        // running without the lock.
        break;
      }
      // Lock is held. Break it if it looks abandoned (stale by mtime).
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
            // Someone else may have just removed/recreated it; retry below.
          }
          continue;
        }
      } catch {
        // The lock vanished between mkdir and stat; retry the acquire.
        continue;
      }
      if (Date.now() >= deadline) {
        // Budget exhausted — proceed WITHOUT the lock rather than hang.
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Best-effort release; never throw from the unlock path.
      }
    }
  }
}

// The actual save (load-previous → prune → atomic write). Assumes the caller
// already holds the state lock; never acquires it itself so callers like
// `updateState` can do load→mutate→save inside a SINGLE lock without a
// re-entrant acquire (which would needlessly burn the lock budget).
function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  // Guard the read-previous-jobs → write sequence so a concurrent writer cannot
  // interleave between the prune-comparison read and the atomic write.
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  // Hold the lock across the WHOLE load→mutate→save so a concurrent
  // read-modify-write cannot lose this update. Re-load INSIDE the lock so the
  // mutation applies to the freshest on-disk state.
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

// Durable, append-only record of a single agy run's captured result, keyed by a
// unique id (the conversation id when known, else a generated job id). This is a
// best-effort audit trail OUTSIDE the job lifecycle — deliberately NOT touched
// by pruneJobs/state.json, so a flaky transcript read never loses a result that
// was actually produced and the answer stays retrievable from a stable path.
export function writeAnswerFile(cwd, answerId, payload) {
  const dir = resolveAnswersDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const answerFile = path.join(dir, `${answerId}.json`);
  atomicWriteFileSync(answerFile, `${JSON.stringify(payload, null, 2)}\n`);
  return answerFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
