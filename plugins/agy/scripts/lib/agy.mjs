import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { readJsonFile } from "./fs.mjs";
import { generateJobId, writeAnswerFile } from "./state.mjs";

/**
 * Antigravity CLI (`agy`) backend.
 *
 * The agy CLI exposes a non-interactive headless mode via `agy --print <prompt>`
 * (aliases `-p` / `--prompt`). There is a known upstream bug
 * (https://github.com/google-antigravity/antigravity-cli/issues/76) where
 * `--print` writes NOTHING to stdout when run under a non-TTY (pipe / subprocess
 * / redirect) — which is exactly how this plugin invokes it. So we cannot read
 * the model answer from stdout.
 *
 * Workaround (same approach as the community bridge): read agy's own transcript
 * file after the run completes:
 *   ~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 * The final assistant answer is the last JSONL entry with
 * { source: "MODEL", status: "DONE", type: "PLANNER_RESPONSE" }.
 *
 * NOTE: the `agy` binary is required at runtime and is NOT bundled here. The
 * exact transcript field names and the cache/last_conversations.json shape vary
 * by agy version, so the parsing below is defensive and overridable via env:
 *   - AGY_STATE_DIR      override the ~/.gemini/antigravity-cli state dir
 *   - AGY_NO_SANDBOX=1   disable the enforced `--sandbox` on read-only runs
 *   - AGY_SANDBOX_WRITE  extra arg(s) for --write runs (e.g. --dangerously-skip-permissions)
 *   - AGY_PRINT_TIMEOUT  value to pass to `--print-timeout`
 *   - AGY_BIN/AGY_BIN_ARG point at a specific agy executable (+ optional leading arg)
 */

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation. Pick the next highest-value step and follow through until the task is resolved.";

const TASK_THREAD_NAME = "Antigravity Companion Task";
const PRINT_MAX_BUFFER = 64 * 1024 * 1024;
// Bounded wall-clock budget for a single agy invocation. The child's stdin is
// closed immediately (input: "") so an interactive prompt sees EOF instead of
// blocking, but a genuinely stuck model run still needs a hard ceiling so the
// worker/session can never hang forever. Override via AGY_TIMEOUT_MS.
const DEFAULT_AGY_TIMEOUT_MS = 600000; // 10 minutes
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// agy may flush its transcript a beat AFTER the `--print` process exits, so an
// immediate read can miss an answer that is about to land. Re-read for a short
// bounded window before concluding "no answer". Override/disable via
// AGY_TRANSCRIPT_SETTLE_MS (0 = read once, no waiting).
const TRANSCRIPT_SETTLE_TOTAL_MS = 1200;
const TRANSCRIPT_SETTLE_STEP_MS = 150;

function resolveAgyTimeoutMs() {
  const raw = process.env.AGY_TIMEOUT_MS;
  if (raw && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_AGY_TIMEOUT_MS;
}

function resolveTranscriptSettleMs() {
  const raw = process.env.AGY_TRANSCRIPT_SETTLE_MS;
  if (raw && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return TRANSCRIPT_SETTLE_TOTAL_MS;
}

// Synchronous, CPU-friendly sleep matching the spawnSync-based flow. Atomics.wait
// blocks on an unshared int32 buffer that is never notified, so it simply times
// out after `ms`; falls back to a bounded busy-wait if Atomics is unavailable.
function sleepSync(ms) {
  if (!(ms > 0)) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    try {
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, " + ms + ")"]);
    } catch {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // busy-wait fallback
      }
    }
  }
}

function resolveStateDir() {
  const override = process.env.AGY_STATE_DIR;
  if (override && override.trim()) {
    return override.trim();
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

// Allow pointing at a specific agy executable (AGY_BIN), optionally with a
// single leading argument (AGY_BIN_ARG) — e.g. AGY_BIN=node AGY_BIN_ARG=agy.mjs
// to run a wrapper. Defaults to the `agy` binary on PATH.
function resolveAgyCommand() {
  const command = (process.env.AGY_BIN && process.env.AGY_BIN.trim()) || "agy";
  const preArg = process.env.AGY_BIN_ARG && process.env.AGY_BIN_ARG.trim();
  return { command, preArgs: preArg ? [preArg] : [] };
}

function isConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID_RE.test(value.trim());
}

function emitProgress(onProgress, message, phase = null) {
  if (typeof onProgress !== "function" || !message) {
    return;
  }
  try {
    onProgress(phase ? { message, phase } : message);
  } catch {
    // Progress reporting must never break the run.
  }
}

function cleanStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/proceeding, even though we could not update PATH/i.test(line))
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Availability / auth / runtime status
 * ------------------------------------------------------------------ */

export function getAntigravityAvailability(cwd) {
  const result = spawnAgy(["--version"], cwd);
  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { available: false, detail };
  }
  return { available: true, detail: String(result.stdout || result.stderr || "ok").trim() };
}

// Best-effort detection of an Antigravity sign-in. Credentials live in the OS
// keyring (so we cannot verify a live session without invoking agy), but agy
// also typically leaves an account/oauth marker under its state dir. Returns a
// real signal when one is found instead of assuming the user is authenticated.
function detectCredentialSignal() {
  const stateDir = resolveStateDir();
  // agy stores Google credentials in the Gemini home — the PARENT of the state
  // dir (e.g. ~/.gemini/oauth_creds.json, ~/.gemini/google_accounts.json), not
  // inside ~/.gemini/antigravity-cli. Search both so a real login is detected.
  const geminiHome = path.dirname(stateDir);
  const candidates = [
    "oauth_creds.json",
    "google_accounts.json",
    "credentials.json",
    "auth.json",
    "token.json",
    "tokens.json",
    "account.json",
    "user.json"
  ];
  for (const name of candidates) {
    for (const dir of [stateDir, geminiHome, path.join(stateDir, "cache"), path.join(stateDir, "auth")]) {
      try {
        if (fs.existsSync(path.join(dir, name))) {
          return true;
        }
      } catch {
        // Ignore unreadable paths.
      }
    }
  }
  return false;
}

export function getAntigravityAuthStatus(cwd) {
  const availability = getAntigravityAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "cli",
      authMethod: null,
      verified: false,
      requiresOpenaiAuth: false,
      provider: "antigravity"
    };
  }

  // We cannot positively verify a live Google session without running agy, so
  // never assert a verified login. Report a real (if best-effort) signal and
  // tell the user how to sign in when none is found.
  const loggedIn = detectCredentialSignal();
  return {
    available: true,
    loggedIn,
    detail: loggedIn
      ? "Antigravity CLI detected and local sign-in credentials were found (not verified live)."
      : "Antigravity CLI detected, but a sign-in could not be confirmed. Run `agy` once interactively to authenticate (Google sign-in).",
    source: "cli",
    authMethod: "google",
    verified: false,
    requiresOpenaiAuth: false,
    provider: "antigravity"
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  return {
    mode: "direct",
    label: "direct CLI",
    detail: "Each command runs the local `agy` CLI directly in headless print mode.",
    endpoint: null
  };
}

export function buildPersistentTaskThreadName(prompt) {
  return TASK_THREAD_NAME;
}

/* ------------------------------------------------------------------ *
 * Transcript reading (the stdout workaround)
 * ------------------------------------------------------------------ */

function brainDir(stateDir) {
  return path.join(stateDir, "brain");
}

function listConversations(stateDir) {
  const dir = brainDir(stateDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const conversations = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    conversations.push({ id: entry.name, dir: full, mtimeMs });
  }
  return conversations;
}

function snapshotConversations(stateDir) {
  const map = new Map();
  for (const conversation of listConversations(stateDir)) {
    map.set(conversation.id, conversation.mtimeMs);
  }
  return map;
}

function readLastConversationId(stateDir) {
  const cacheFile = path.join(stateDir, "cache", "last_conversations.json");
  let data;
  try {
    data = readJsonFile(cacheFile);
  } catch {
    return null;
  }

  // The cache shape varies by version; accept the common possibilities.
  const candidates = [];
  const collect = (value) => {
    if (!value) {
      return;
    }
    if (typeof value === "string") {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
    } else if (typeof value === "object") {
      for (const key of ["conversationId", "conversation_id", "id"]) {
        if (typeof value[key] === "string") {
          candidates.push(value[key]);
        }
      }
    }
  };
  collect(data);
  return candidates.find((id) => isConversationId(id)) ?? candidates[0] ?? null;
}

function resolveConversationId(stateDir, before, resumeThreadId) {
  if (isConversationId(resumeThreadId)) {
    return resumeThreadId;
  }

  const after = listConversations(stateDir);

  // Correlate by the before/after SET DIFFERENCE rather than an mtime scan: the
  // caller snapshots existing conversation ids into `before`, so a conversation
  // that is present now but absent from `before` was created by THIS run. This
  // is robust even when two conversations share an mtime (an mtime-only scan
  // can tie-break to the wrong one). The CLI generates its own conversation ids
  // and `--conversation` only RESUMES an existing one, so we cannot pin a fresh
  // id up front — set difference is the most race-resistant correlation we can
  // do post-hoc.
  const newConversations = after.filter((conversation) => !before.has(conversation.id));
  if (newConversations.length === 1) {
    // Exactly one new conversation: unambiguous, even under mtime ties.
    return newConversations[0].id;
  }
  if (newConversations.length > 1) {
    // Genuinely concurrent runs created multiple new conversations at once.
    // RESIDUAL CONCURRENCY CAVEAT: we cannot tell which new conversation
    // belongs to THIS run, so we pick the newest by mtime as a best effort.
    // Pinning a client-supplied id would fix this, but the agy CLI does not
    // support supplying a fresh conversation id (only resuming an existing one).
    return [...newConversations].sort((left, right) => right.mtimeMs - left.mtimeMs)[0].id;
  }

  // No new conversation id (resume/reuse of an existing conversation). Fall
  // back to agy's own "most recent conversation" pointer, then to the newest
  // conversation directory overall.
  const cached = readLastConversationId(stateDir);
  if (cached) {
    return cached;
  }
  const newest = [...after].sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  return newest?.id ?? null;
}

function transcriptPath(stateDir, conversationId) {
  return path.join(stateDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

// agy writes a sibling `transcript_full.jsonl` next to `transcript.jsonl`. It
// sometimes carries the final MODEL entry when the primary transcript is absent
// or was never flushed for a `--print` run, so it is read as a fallback.
function transcriptFullPath(stateDir, conversationId) {
  return path.join(stateDir, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

// Best-effort look at what agy left on disk for a conversation. Used to tell a
// genuinely empty run (nothing written — e.g. the session was still
// authenticating) apart from a run whose transcript merely lacked a text answer.
function probeConversationArtifacts(stateDir, conversationId) {
  const empty = {
    hasBrainDir: false,
    transcriptExists: false,
    transcriptFullExists: false,
    dbExists: false
  };
  if (!conversationId) {
    return empty;
  }
  const exists = (target) => {
    try {
      return fs.existsSync(target);
    } catch {
      return false;
    }
  };
  return {
    hasBrainDir: exists(path.join(stateDir, "brain", conversationId)),
    transcriptExists: exists(transcriptPath(stateDir, conversationId)),
    transcriptFullExists: exists(transcriptFullPath(stateDir, conversationId)),
    dbExists: exists(path.join(stateDir, "conversations", `${conversationId}.db`))
  };
}

function isFinalModelEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const source = String(entry.source ?? "").toUpperCase();
  const status = String(entry.status ?? "").toUpperCase();
  const type = String(entry.type ?? "").toUpperCase();
  return source === "MODEL" && status === "DONE" && type === "PLANNER_RESPONSE";
}

function extractEntryText(entry) {
  for (const key of ["text", "content", "message", "response", "body", "answer", "output"]) {
    const value = entry?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  // Some shapes nest the text under a content array of parts.
  if (Array.isArray(entry?.content)) {
    const parts = entry.content
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter((part) => typeof part === "string" && part.trim());
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return "";
}

// Track whether ANY final MODEL entry was produced, independent of whether it
// carried text. A turn that ends on tool calls/edits emits PLANNER_RESPONSE
// entries with empty text, so `finalMessage` stays "" even though the run
// succeeded — callers use `sawFinalEntry` to tell that apart from a genuinely
// empty run (no model response at all). `entryCount` records how many JSONL
// lines parsed, so callers can tell an empty file from one with content.
function parseTranscriptText(raw) {
  let finalMessage = "";
  let lastTurnId = null;
  let sawFinalEntry = false;
  let entryCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    entryCount += 1;
    if (isFinalModelEntry(entry)) {
      sawFinalEntry = true;
      const text = extractEntryText(entry);
      if (text) {
        finalMessage = text;
      }
      lastTurnId = entry.id ?? entry.turnId ?? entry.turn_id ?? lastTurnId;
    }
  }
  return { finalMessage, lastTurnId, sawFinalEntry, entryCount };
}

function readTranscriptFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseTranscriptText(raw);
}

// Read the model answer from agy's transcript, preferring `transcript.jsonl`
// and falling back to `transcript_full.jsonl` when the primary is absent or
// carried no final entry. Returns the parsed result plus `source` (which file
// the result came from), or null when neither file is readable.
function readTranscript(stateDir, conversationId) {
  if (!conversationId) {
    return null;
  }
  const hasSignal = (parsed) => Boolean(parsed && (parsed.finalMessage || parsed.sawFinalEntry));

  const primary = readTranscriptFile(transcriptPath(stateDir, conversationId));
  if (hasSignal(primary)) {
    return { ...primary, source: "transcript.jsonl" };
  }
  const full = readTranscriptFile(transcriptFullPath(stateDir, conversationId));
  if (hasSignal(full)) {
    return { ...full, source: "transcript_full.jsonl" };
  }
  // Neither carried a final entry. Preserve whatever was readable (empty
  // finalMessage / sawFinalEntry=false) so callers see a consistent shape.
  if (primary) {
    return { ...primary, source: "transcript.jsonl" };
  }
  if (full) {
    return { ...full, source: "transcript_full.jsonl" };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Running agy
 * ------------------------------------------------------------------ */

function buildSandboxArgs(sandbox) {
  const write = sandbox === "workspace-write" || sandbox === "write";
  if (write) {
    // Write mode: agy must act without interactive confirmation in --print mode.
    // Let the user opt into the exact flag(s) their agy version needs (e.g.
    // "--dangerously-skip-permissions") instead of enabling that implicitly.
    const extra = process.env.AGY_SANDBOX_WRITE;
    return extra && extra.trim() ? extra.trim().split(/\s+/) : [];
  }
  // Read-only / default: enforce agy's sandbox so a review or read-only task
  // cannot modify the host filesystem. agy's `--sandbox` is a boolean toggle.
  // AGY_NO_SANDBOX=1 is an escape hatch for agy versions where it is unavailable.
  if (process.env.AGY_NO_SANDBOX === "1") {
    return [];
  }
  return ["--sandbox"];
}

function spawnAgy(args, cwd) {
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const baseOptions = {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: PRINT_MAX_BUFFER,
    windowsHide: true,
    // Hard wall-clock ceiling so a stuck agy run can never hang the worker
    // forever; on expiry spawnSync kills the child and reports ETIMEDOUT/signal.
    timeout: resolveAgyTimeoutMs(),
    // Close the child's stdin immediately so any interactive confirmation
    // prompt (e.g. in --write mode) reads EOF instead of blocking on a pipe.
    input: ""
  };

  const { command, preArgs } = resolveAgyCommand();
  const fullArgs = [...preArgs, ...args];

  // Pass argv directly (shell:false) so multi-line / quoted prompts (the stop
  // gate prompt contains < > characters) survive intact. Fall back to a shell
  // on Windows only if a bare `agy` can't be found that way (e.g. a .cmd shim).
  let result = spawnSync(command, fullArgs, { ...baseOptions, shell: false });
  if (
    /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ENOENT" &&
    process.platform === "win32" &&
    preArgs.length === 0
  ) {
    result = spawnSync(command, fullArgs, { ...baseOptions, shell: true });
  }
  return result;
}

export async function runAppServerTurn(cwd, options = {}) {
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  const resuming = Boolean(options.resumeThreadId);
  if (!prompt && !resuming) {
    throw new Error("A prompt is required for this Antigravity run.");
  }

  const stateDir = resolveStateDir();
  const before = snapshotConversations(stateDir);

  const args = ["--print"];
  if (resuming) {
    if (isConversationId(options.resumeThreadId)) {
      args.push("--conversation", options.resumeThreadId);
    } else {
      // We don't have a specific conversation id; resume agy's most recent one.
      args.push("--continue");
    }
  }
  if (prompt) {
    args.push(prompt);
  }
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (process.env.AGY_PRINT_TIMEOUT && process.env.AGY_PRINT_TIMEOUT.trim()) {
    args.push("--print-timeout", process.env.AGY_PRINT_TIMEOUT.trim());
  }
  args.push(...buildSandboxArgs(options.sandbox));

  // Surface a best-effort auth warning BEFORE running: the most common cause of
  // an empty run is an unconfirmed sign-in (the session spends its time logging
  // in and never produces a turn). This is a WARNING, not a block — credential
  // detection is heuristic and can yield a false negative.
  let authWarning = null;
  const authStatus = getAntigravityAuthStatus(cwd);
  if (authStatus.available && !authStatus.loggedIn) {
    authWarning = authStatus.detail;
    emitProgress(
      options.onProgress,
      "Warning: could not confirm an Antigravity sign-in. If this run produces no answer, run `agy` once interactively to authenticate (or /agy:setup).",
      "warning"
    );
  }

  emitProgress(options.onProgress, resuming ? "Resuming Antigravity conversation." : "Starting Antigravity run.", "starting");

  const result = spawnAgy(args, cwd);
  const stderr = cleanStderr(result.stderr);

  // spawnSync surfaces a timeout as error.code === "ETIMEDOUT" and/or by
  // killing the child with a signal (e.g. SIGTERM). Treat either as a hard
  // failure: a stuck run must never look like a successful turn just because a
  // stale transcript happens to exist on disk.
  const timedOut =
    /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT" ||
    (result.signal !== null && result.signal !== undefined);
  if (timedOut) {
    const timeoutMs = resolveAgyTimeoutMs();
    return {
      status: 1,
      threadId: null,
      turnId: null,
      finalMessage: `Antigravity timed out after ${timeoutMs} ms (set AGY_TIMEOUT_MS to adjust).`,
      reasoningSummary: [],
      touchedFiles: [],
      stderr,
      error: result.error ?? null,
      answerFile: null,
      diagnostic: "timeout",
      authWarning,
      turn: { id: "agy-turn", status: "failed" }
    };
  }

  emitProgress(options.onProgress, "Reading Antigravity transcript.", "finalizing");

  const conversationId = resolveConversationId(stateDir, before, options.resumeThreadId);
  let transcript = readTranscript(stateDir, conversationId);

  // agy may flush the transcript a beat AFTER the --print process exits, so the
  // first read can miss an answer that is about to land. Re-read for a short
  // bounded window before concluding there is no answer. Disabled with
  // AGY_TRANSCRIPT_SETTLE_MS=0 (e.g. in tests) for an immediate single read.
  const settleMs = resolveTranscriptSettleMs();
  if (conversationId && settleMs > 0) {
    const deadline = Date.now() + settleMs;
    while (
      (!transcript || (!transcript.finalMessage && !transcript.sawFinalEntry)) &&
      Date.now() < deadline
    ) {
      sleepSync(Math.min(TRANSCRIPT_SETTLE_STEP_MS, deadline - Date.now()));
      transcript = readTranscript(stateDir, conversationId);
    }
  }

  // stdout is normally empty under non-TTY, but honor it if a fixed agy version
  // ever does print, before falling back to the transcript.
  const stdoutText = String(result.stdout ?? "").trim();
  const finalMessage = stdoutText || transcript?.finalMessage || "";

  // A turn that ends on tool calls or file edits (the common shape for `--write`
  // tasks) leaves an empty final answer even though agy ran and may have changed
  // files. That is NOT a failure: only treat an empty answer as failed when the
  // process itself failed OR no final MODEL entry was produced at all. Otherwise
  // a successful write run was being reported as a failure.
  const sawFinalEntry = Boolean(transcript?.sawFinalEntry);
  const spawnFailed = Boolean(result.error) || (typeof result.status === "number" && result.status !== 0);
  const failed = spawnFailed || (!finalMessage && !sawFinalEntry);

  // Distinguish "agy produced nothing at all" (no transcript written — typically
  // the session was still authenticating) from "ran but the final entry carried
  // no text" (ended on tool calls/edits, which DOES write a transcript). Only the
  // former gets the actionable auth hint instead of the opaque transcript message.
  const artifacts = probeConversationArtifacts(stateDir, conversationId);
  const producedNothing =
    !finalMessage &&
    !sawFinalEntry &&
    !artifacts.transcriptExists &&
    !artifacts.transcriptFullExists;
  const diagnostic = failed && producedNothing && !spawnFailed ? "auth-or-incomplete" : null;

  let emptyAnswerNote;
  if (failed) {
    if (diagnostic === "auth-or-incomplete") {
      emptyAnswerNote =
        "Antigravity could not confirm sign-in or did not produce a response. " +
        "Run `agy` once interactively to authenticate (Google sign-in), then retry." +
        (stderr ? `\n\nLast diagnostics:\n${stderr}` : "");
    } else {
      emptyAnswerNote = stderr || "Antigravity produced no readable answer (no transcript entry was found).";
    }
  } else {
    emptyAnswerNote = `Antigravity finished the turn without a text answer (it likely ended on tool calls or file edits). Review your working tree with \`git status\` / \`git diff\`, or resume with \`agy --conversation=${conversationId ?? "<id>"}\`.`;
  }

  const resolvedMessage = finalMessage || emptyAnswerNote;

  // Persist this run's captured result to a uniquely-named file so a real answer
  // is never lost to a flaky/slow read and stays retrievable from a stable path
  // (the user's request). Best-effort: a write error must never flip a good run
  // to failure, so it is swallowed.
  let answerFile = null;
  try {
    // Unique per RUN, not just per conversation: a resumed conversation writes a
    // new answer every turn, so keying only by conversationId would overwrite the
    // previous turn's answer. generateJobId adds a time+random suffix; the
    // conversation id (when known) stays in the name for grouping/discoverability.
    const answerPrefix =
      conversationId && isConversationId(conversationId) ? `answer-${conversationId}` : "answer";
    const answerId = generateJobId(answerPrefix);
    answerFile = writeAnswerFile(cwd, answerId, {
      schemaVersion: 1,
      answerId,
      conversationId: conversationId ?? null,
      turnId: transcript?.lastTurnId ?? null,
      status: failed ? 1 : 0,
      finalMessage: resolvedMessage,
      hadTextAnswer: Boolean(finalMessage),
      sawFinalEntry,
      transcriptSource: transcript?.source ?? null,
      diagnostic,
      authWarning,
      stderr: stderr || null,
      artifacts,
      timestamp: new Date().toISOString()
    });
  } catch {
    answerFile = null;
  }

  return {
    status: failed ? 1 : 0,
    threadId: conversationId,
    turnId: transcript?.lastTurnId ?? null,
    finalMessage: resolvedMessage,
    reasoningSummary: [],
    touchedFiles: [],
    stderr,
    error: result.error ?? null,
    answerFile,
    diagnostic,
    authWarning,
    turn: { id: transcript?.lastTurnId ?? "agy-turn", status: failed ? "failed" : "completed" }
  };
}

export async function runAppServerReview(cwd, options = {}) {
  const target = options.target ?? {};
  const targetLabel =
    target.type === "baseBranch" ? `base branch ${target.branch}` : "the uncommitted changes";
  const prompt = [
    `Review ${targetLabel} in this repository as a senior engineer giving a constructive code review.`,
    "Point out likely bugs, logic errors, broken edge cases, regressions, and questionable design or maintainability decisions.",
    "Be concrete: cite file paths and line numbers, and lead with the most important issues."
  ].join(" ");

  const result = await runAppServerTurn(cwd, {
    prompt,
    model: options.model,
    sandbox: "read-only",
    onProgress: options.onProgress
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: null,
    turnId: result.turnId,
    reviewText: result.finalMessage,
    reasoningSummary: result.reasoningSummary ?? [],
    stderr: result.stderr,
    answerFile: result.answerFile ?? null,
    diagnostic: result.diagnostic ?? null
  };
}

export function findLatestTaskThread(workspaceRoot) {
  const stateDir = resolveStateDir();
  const newest = listConversations(stateDir).sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  return newest ? { id: newest.id } : null;
}

export async function interruptAppServerTurn(
  cwd,
  /** @type {{ threadId?: string | null, turnId?: string | null }} */ { threadId, turnId } = {}
) {
  // agy runs as a one-shot CLI; there is no live turn to interrupt over a
  // protocol. Cancellation is handled by terminating the worker process tree
  // in the companion. Report honestly so the caller can log it.
  return {
    attempted: false,
    interrupted: false,
    transport: "cli",
    detail: "Antigravity runs as a one-shot CLI; cancellation terminates the worker process instead."
  };
}

/* ------------------------------------------------------------------ *
 * Structured output helpers
 * ------------------------------------------------------------------ */

// The agy/Gemini model frequently wraps its JSON answer in a markdown code
// fence (```json ... ```), which makes a raw JSON.parse throw on the leading
// backticks. Strip a single leading fence line (```json / ``` with optional
// whitespace) and a trailing ``` fence, tolerating surrounding whitespace and
// newlines. Returns the inner content when a fence is present, else the
// trimmed input. Exported so callers/tests can reuse the same normalization.
export function stripCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  // Drop the opening fence line: ``` optionally followed by a language tag
  // (e.g. ```json) and trailing whitespace, up to and including its newline.
  const withoutOpen = trimmed.replace(/^```[^\n]*\r?\n?/, "");
  // Drop a trailing fence (``` possibly preceded by whitespace/newlines).
  const withoutClose = withoutOpen.replace(/\r?\n?[ \t]*```[ \t]*$/, "");
  return withoutClose.trim();
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Antigravity did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  // Parse the de-fenced text, but keep the ORIGINAL rawOutput for display.
  const candidate = stripCodeFence(rawOutput);
  try {
    return {
      parsed: JSON.parse(candidate),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  try {
    return readJsonFile(schemaPath);
  } catch {
    return null;
  }
}
