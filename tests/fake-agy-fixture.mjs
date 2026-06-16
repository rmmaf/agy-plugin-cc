import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Installs a fake `agy` CLI used by the runtime tests.
 *
 * It mimics the real agy headless behaviour that this plugin depends on:
 *   - `agy --version` prints a version and exits 0.
 *   - `agy --print <prompt> [--model m] [--conversation id|-c] [--sandbox v]`
 *     writes a transcript at
 *       $AGY_STATE_DIR/brain/<id>/.system_generated/logs/transcript.jsonl
 *     whose final MODEL/DONE/PLANNER_RESPONSE entry holds the answer,
 *     records the conversation id in cache/last_conversations.json,
 *     and PRINTS NOTHING to stdout (simulating the non-TTY stdout bug).
 *
 * The fake is run as `node <fake-agy.cjs>` via the AGY_BIN / AGY_BIN_ARG env
 * overrides, so it works identically on Windows and POSIX without relying on a
 * .cmd shim or shell quoting (the stop-gate prompt contains < > characters).
 */
export function installFakeAgy(binDir) {
  const scriptPath = path.join(binDir, "fake-agy.cjs");
  const source = `"use strict";
const fs = require("node:fs");
const path = require("node:path");

const BEHAVIOR = process.env.AGY_FAKE_BEHAVIOR || "default";
const STATE_PATH = process.env.AGY_FAKE_STATE || path.join(__dirname, "fake-agy-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { runs: 0, nextId: 1 };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("agy 0.0.0-fake\\n");
  process.exit(0);
}

let print = false;
let prompt = null;
let model = null;
let conversation = null;
let cont = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--print" || a === "-p" || a === "--prompt") {
    print = true;
  } else if (a === "--model") {
    model = args[i + 1];
    i += 1;
  } else if (a === "--conversation") {
    conversation = args[i + 1];
    i += 1;
  } else if (a === "-c" || a === "--continue") {
    cont = true;
  } else if (a === "--sandbox") {
    // boolean flag, no value
  } else if (a === "--print-timeout") {
    i += 1;
  } else if (!a.startsWith("-") && prompt === null) {
    prompt = a;
  }
}

if (!print) {
  process.stderr.write("fake agy: interactive mode is not supported in tests\\n");
  process.exit(1);
}

const stateDir = process.env.AGY_STATE_DIR;
if (!stateDir) {
  process.stderr.write("fake agy: AGY_STATE_DIR is not set\\n");
  process.exit(3);
}

const state = loadState();
let id = conversation || (cont ? state.lastConversationId : null);
if (!id) {
  id = "00000000-0000-4000-8000-" + String(state.nextId++).padStart(12, "0");
}

function answerFor(text) {
  const value = String(text || "");
  if (value.includes("<task>") && value.includes("Only review the work from the previous Claude turn")) {
    return BEHAVIOR === "stop-allow"
      ? "ALLOW: No blocking issues found in the previous turn."
      : "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }
  if (/^Review /.test(value)) {
    return "No material issues found in the reviewed changes.";
  }
  if (conversation || cont) {
    return "Resumed the prior conversation.\\nFollow-up handled.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}
const answer = answerFor(prompt);

const logDir = path.join(stateDir, "brain", id, ".system_generated", "logs");
const transcriptBody =
  [
    JSON.stringify({ source: "USER", status: "DONE", type: "USER_MESSAGE", text: prompt || "" }),
    JSON.stringify({ source: "MODEL", status: "DONE", type: "PLANNER_RESPONSE", id: "turn-" + id, text: answer })
  ].join("\\n") + "\\n";
if (BEHAVIOR === "none") {
  // Mimic an auth-incomplete run: the conversation dir exists but agy never
  // wrote any transcript (no model answer was produced).
  fs.mkdirSync(path.join(stateDir, "brain", id), { recursive: true });
} else {
  // "full-only" exercises the transcript_full.jsonl fallback: only the sibling
  // file is written, never the primary transcript.jsonl.
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, BEHAVIOR === "full-only" ? "transcript_full.jsonl" : "transcript.jsonl"), transcriptBody);
}

const cacheDir = path.join(stateDir, "cache");
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, "last_conversations.json"), JSON.stringify([{ id }], null, 2));

state.runs = (state.runs || 0) + 1;
state.lastConversationId = id;
state.lastRun = { prompt, model, conversation, continue: cont, argv: args };
saveState(state);

// Simulate the real --print non-TTY bug: nothing on stdout.
process.exit(0);
`;
  fs.writeFileSync(scriptPath, source, { encoding: "utf8" });
  return scriptPath;
}

export function buildEnv({ binDir, stateDir, behavior = "default" }) {
  const scriptPath = path.join(binDir, "fake-agy.cjs");
  return {
    ...process.env,
    AGY_BIN: process.execPath,
    AGY_BIN_ARG: scriptPath,
    AGY_STATE_DIR: stateDir,
    AGY_FAKE_STATE: path.join(binDir, "fake-agy-state.json"),
    AGY_FAKE_BEHAVIOR: behavior
  };
}

export function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-agy-state.json"), "utf8"));
}
