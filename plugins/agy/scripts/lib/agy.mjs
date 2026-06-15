import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { readJsonFile } from "./fs.mjs";

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
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  if (result.error?.code === "ENOENT") {
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

  // Prefer a conversation that is new or was touched during this run.
  const touched = after
    .filter((conversation) => {
      const previous = before.get(conversation.id);
      return previous === undefined || conversation.mtimeMs > previous;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (touched.length > 0) {
    return touched[0].id;
  }

  // Fall back to agy's own "most recent conversation" pointer, then to the
  // newest conversation directory overall.
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

function readTranscript(stateDir, conversationId) {
  if (!conversationId) {
    return null;
  }
  const file = transcriptPath(stateDir, conversationId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let finalMessage = "";
  let lastTurnId = null;
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
    if (isFinalModelEntry(entry)) {
      const text = extractEntryText(entry);
      if (text) {
        finalMessage = text;
      }
      lastTurnId = entry.id ?? entry.turnId ?? entry.turn_id ?? lastTurnId;
    }
  }

  return { finalMessage, lastTurnId };
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
  const baseOptions = {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: PRINT_MAX_BUFFER,
    windowsHide: true
  };

  const { command, preArgs } = resolveAgyCommand();
  const fullArgs = [...preArgs, ...args];

  // Pass argv directly (shell:false) so multi-line / quoted prompts (the stop
  // gate prompt contains < > characters) survive intact. Fall back to a shell
  // on Windows only if a bare `agy` can't be found that way (e.g. a .cmd shim).
  let result = spawnSync(command, fullArgs, { ...baseOptions, shell: false });
  if (result.error?.code === "ENOENT" && process.platform === "win32" && preArgs.length === 0) {
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

  emitProgress(options.onProgress, resuming ? "Resuming Antigravity conversation." : "Starting Antigravity run.", "starting");

  const result = spawnAgy(args, cwd);
  const stderr = cleanStderr(result.stderr);

  emitProgress(options.onProgress, "Reading Antigravity transcript.", "finalizing");

  const conversationId = resolveConversationId(stateDir, before, options.resumeThreadId);
  const transcript = readTranscript(stateDir, conversationId);

  // stdout is normally empty under non-TTY, but honor it if a fixed agy version
  // ever does print, before falling back to the transcript.
  const stdoutText = String(result.stdout ?? "").trim();
  const finalMessage = stdoutText || transcript?.finalMessage || "";

  const spawnFailed = Boolean(result.error) || (typeof result.status === "number" && result.status !== 0);
  const failed = spawnFailed || !finalMessage;

  return {
    status: failed ? 1 : 0,
    threadId: conversationId,
    turnId: transcript?.lastTurnId ?? null,
    finalMessage:
      finalMessage ||
      (stderr ? stderr : "Antigravity produced no readable answer (no transcript entry was found)."),
    reasoningSummary: [],
    touchedFiles: [],
    stderr,
    error: result.error ?? null,
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
    stderr: result.stderr
  };
}

export function findLatestTaskThread(workspaceRoot) {
  const stateDir = resolveStateDir();
  const newest = listConversations(stateDir).sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  return newest ? { id: newest.id } : null;
}

export async function interruptAppServerTurn(cwd, { threadId, turnId } = {}) {
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

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Antigravity did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
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
