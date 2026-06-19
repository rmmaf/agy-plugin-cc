#!/usr/bin/env node

// UserPromptSubmit hook for the research-before/while-plan options.
//
// When `researchBeforePlan` / `researchWhilePlan` are enabled via `/agy:setup`,
// inject guidance (once per session) telling Claude to run `/agy:research`
// around planning. Claude Code has no native "plan started" event, so this is a
// best-effort standing nudge surfaced through the documented UserPromptSubmit
// `additionalContext` channel.
//
// This hook is STRICTLY fail-open: it must never block prompt submission. On
// any error it emits nothing and exits 0 (unlike the Stop gate, which fails
// closed by design).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getConfig, resolveStateDir } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function buildGuidance(config) {
  const blocks = [];
  if (config.researchBeforePlan) {
    blocks.push(
      "Antigravity research-before-plan is enabled. Before you produce an implementation plan, run `/agy:research` (or `agy-companion.mjs research`) on three topics: (1) architectural approaches for this problem, from simplest to state-of-the-art; (2) relevant technologies, libraries, frameworks, or services with their pros and cons; (3) project-domain background. Fold the findings into the plan. If `save research` is enabled, the reports persist to the project knowledge base."
    );
  }
  if (config.researchWhilePlan) {
    blocks.push(
      "Antigravity research-while-plan is enabled. While planning, you may run `/agy:research` on any sub-topic you judge important (an unfamiliar dependency, protocol, or failure mode) before locking in decisions."
    );
  }
  return blocks.join(" ");
}

function resolveMarkerFile(workspaceRoot, sessionId) {
  if (!sessionId) {
    return null;
  }
  try {
    return path.join(resolveStateDir(workspaceRoot), `plan-research-injected-${sessionId}.marker`);
  } catch {
    return null;
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  if (!config.researchBeforePlan && !config.researchWhilePlan) {
    return;
  }

  const guidance = buildGuidance(config);
  if (!guidance) {
    return;
  }

  // Inject at most once per session to avoid repeating on every prompt.
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const markerFile = resolveMarkerFile(workspaceRoot, sessionId);
  if (markerFile && fs.existsSync(markerFile)) {
    return;
  }
  if (markerFile) {
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, new Date().toISOString(), "utf8");
    } catch {
      // Best-effort; re-injecting next prompt is acceptable if this fails.
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: guidance
      }
    })}\n`
  );
}

try {
  main();
} catch {
  // Fail open: never block prompt submission. Emit nothing, exit 0.
}
