#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getAntigravityAuthStatus,
    getAntigravityAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/agy.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  buildResearchPrompt,
  buildVerificationPrompt,
  formatPrintTimeout,
  INTENSITY_PRESETS,
  parseGoDurationSeconds,
  parseVerificationOutput,
  resolveIntensity
} from "./lib/research-prompts.mjs";
import { regenerateIndexSkill, writeKbEntry } from "./lib/knowledge-base.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderResearchResult,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// Boolean research config flags toggled through `/agy:setup`, following the
// same enable/disable pattern as the stop-time review gate. Each maps a kebab
// flag pair to a camelCase config key (persisted in state.json) and a report
// field surfaced by buildSetupReport/renderSetupReport.
const RESEARCH_CONFIG_FLAGS = [
  {
    key: "saveResearch",
    enable: "enable-save-research",
    disable: "disable-save-research",
    label: "save research",
    reportKey: "saveResearchEnabled"
  },
  {
    key: "saveReviewedResearch",
    enable: "enable-save-reviewed-research",
    disable: "disable-save-reviewed-research",
    label: "save reviewed research",
    reportKey: "saveReviewedResearchEnabled"
  },
  {
    key: "researchBeforePlan",
    enable: "enable-research-before-plan",
    disable: "disable-research-before-plan",
    label: "research before plan",
    reportKey: "researchBeforePlanEnabled"
  },
  {
    key: "researchWhilePlan",
    enable: "enable-research-while-plan",
    disable: "disable-research-while-plan",
    label: "research while plan",
    reportKey: "researchWhilePlanEnabled"
  }
];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/agy-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/agy-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/agy-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high>] [prompt]",
      "  node scripts/agy-companion.mjs research [--intensity <low|medium|high>] [--background] [--save] [--model <model>] <topic>",
      "  node scripts/agy-companion.mjs analyse-plan [--plan-file <path>] [--model <model>] [focus text]",
      "  node scripts/agy-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/agy-companion.mjs result [job-id] [--json]",
      "  node scripts/agy-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const AntigravityStatus = getAntigravityAvailability(cwd);
  const authStatus = await getAntigravityAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!AntigravityStatus.available) {
    nextSteps.push("Install the Antigravity CLI — Windows: `irm https://antigravity.google/cli/install.ps1 | iex`; macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`.");
  }
  if (AntigravityStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Sign in by running `agy` once interactively (Google sign-in opens a browser; on a headless/SSH box it prints a URL and one-time code).");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agy:setup --enable-review-gate` to require a fresh review before stop.");
  }
  if (!config.saveResearch && !config.saveReviewedResearch) {
    nextSteps.push("Optional: run `/agy:setup --enable-save-research` to persist `/agy:research` reports to a project knowledge base.");
  }
  if (config.saveReviewedResearch) {
    nextSteps.push("Note: \"save reviewed research\" runs a second Antigravity verification pass before saving, which roughly doubles research latency and cost.");
  }

  const researchFlags = {};
  for (const flag of RESEARCH_CONFIG_FLAGS) {
    researchFlags[flag.reportKey] = Boolean(config[flag.key]);
  }

  return {
    // A live Google sign-in cannot be verified without invoking agy, so base
    // readiness on the installed tooling and surface sign-in as a next step.
    ready: nodeStatus.available && AntigravityStatus.available,
    node: nodeStatus,
    npm: npmStatus,
    Antigravity: AntigravityStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    ...researchFlags,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const researchFlagOptions = RESEARCH_CONFIG_FLAGS.flatMap((flag) => [flag.enable, flag.disable]);
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", ...researchFlagOptions]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  for (const flag of RESEARCH_CONFIG_FLAGS) {
    if (options[flag.enable] && options[flag.disable]) {
      throw new Error(`Choose either --${flag.enable} or --${flag.disable}.`);
    }
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  for (const flag of RESEARCH_CONFIG_FLAGS) {
    if (options[flag.enable]) {
      setConfig(workspaceRoot, flag.key, true);
      actionsTaken.push(`Enabled "${flag.label}" for ${workspaceRoot}.`);
    } else if (options[flag.disable]) {
      setConfig(workspaceRoot, flag.key, false);
      actionsTaken.push(`Disabled "${flag.label}" for ${workspaceRoot}.`);
    }
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureAntigravityAvailable(cwd) {
  const availability = getAntigravityAvailability(cwd);
  if (!availability.available) {
    throw new Error("Antigravity CLI is not installed or is not on PATH. Install it (Windows: `irm https://antigravity.google/cli/install.ps1 | iex`; macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`), then rerun `/agy:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/agy:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/agy:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/agy:review` target is not supported by the built-in reviewer. Retry with `/agy:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /agy:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureAntigravityAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      Antigravity: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary,
        answerFile: result.answerFile ?? null,
        diagnostic: result.diagnostic ?? null
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Antigravity ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    Antigravity: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
      answerFile: result.answerFile ?? null,
      diagnostic: result.diagnostic ?? null
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Antigravity ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAntigravityAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Antigravity task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    answerFile: result.answerFile ?? null,
    diagnostic: result.diagnostic ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function applyResearchTimeoutBudget(timeoutSec) {
  // Each `node agy-companion.mjs research` invocation (and each detached
  // task-worker) is its own OS process, so setting these env vars is
  // process-local and cannot race other runs. Respect any user override.
  if (!process.env.AGY_PRINT_TIMEOUT || !process.env.AGY_PRINT_TIMEOUT.trim()) {
    process.env.AGY_PRINT_TIMEOUT = formatPrintTimeout(timeoutSec);
  }
  if (!process.env.AGY_TIMEOUT_MS || !process.env.AGY_TIMEOUT_MS.trim()) {
    // Keep the hard wall-clock ceiling above the EFFECTIVE print-timeout. A user
    // may have raised AGY_PRINT_TIMEOUT without also raising AGY_TIMEOUT_MS, so
    // base the headroom on whichever is larger — the preset or the user's
    // print-timeout — otherwise a long user-requested run would be killed early.
    const printSec = parseGoDurationSeconds(process.env.AGY_PRINT_TIMEOUT);
    const effectiveSec = Math.max(Math.round(timeoutSec), Math.round(printSec ?? 0));
    process.env.AGY_TIMEOUT_MS = String((Math.max(1, effectiveSec) + 120) * 1000);
  }
}

async function executeResearchRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAntigravityAvailable(request.cwd);

  const intensity = resolveIntensity(request.intensity);
  const preset = INTENSITY_PRESETS[intensity];
  const topic = String(request.topic ?? "").trim();
  if (!topic) {
    throw new Error("Provide a research topic.");
  }

  applyResearchTimeoutBudget(preset.timeoutSec);

  const result = await runAppServerTurn(workspaceRoot, {
    prompt: buildResearchPrompt({ topic, intensity }),
    model: request.model,
    sandbox: "read-only",
    onProgress: request.onProgress
  });

  const firstReport = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const succeeded = result.status === 0 && Boolean(firstReport.trim());

  // Save precedence: saveReviewedResearch -> verify then save; else --save or
  // saveResearch -> save raw; else don't save.
  const cfg = getConfig(workspaceRoot);
  const verify = Boolean(cfg.saveReviewedResearch);
  const wantSave = verify || Boolean(request.save) || Boolean(cfg.saveResearch);

  let finalBody = firstReport;
  let reviewed = false;
  let verificationNote = null;

  if (verify && succeeded) {
    const verifyResult = await runAppServerTurn(workspaceRoot, {
      prompt: buildVerificationPrompt({ topic, firstReport }),
      model: request.model,
      sandbox: "read-only",
      onProgress: request.onProgress
    });
    const verifyText = typeof verifyResult.finalMessage === "string" ? verifyResult.finalMessage : "";
    // Only trust the verify pass when it succeeded with real text AND followed
    // the VERIFIED/CORRECTED contract. A turn that ends on tool calls returns a
    // non-empty boilerplate "no text answer" note (status 0, no marker);
    // accepting that would clobber the genuine first report and mislabel it as
    // reviewed. In every unusable/unmarked case, keep the first report and save
    // it as unverified rather than overwriting it.
    const usable = verifyResult.status === 0 && !verifyResult.diagnostic && Boolean(verifyText.trim());
    const parsed = usable ? parseVerificationOutput(verifyText) : null;
    if (parsed && parsed.status === "verified") {
      // VERIFIED means "report unchanged" — keep the original report as-is.
      reviewed = true;
      verificationNote = parsed.note
        ? `Verified by a second Antigravity pass; no corrections needed. ${parsed.note}`
        : "Verified by a second Antigravity pass; no corrections needed.";
    } else if (parsed && parsed.status === "corrected" && parsed.body) {
      finalBody = parsed.body;
      reviewed = true;
      verificationNote = parsed.note
        ? `Verified by a second Antigravity pass; corrections applied: ${parsed.note}`
        : "Verified by a second Antigravity pass; corrections applied.";
    } else {
      reviewed = false;
      verificationNote =
        "Verification pass did not return a usable VERIFIED/CORRECTED result; saved the unverified report.";
    }
  }

  let savedFile = null;
  let indexResult = null;
  let saveError = null;
  if (wantSave && succeeded && finalBody.trim()) {
    try {
      const written = writeKbEntry(workspaceRoot, { topic, intensity, reviewed, body: finalBody });
      savedFile = written.file;
      indexResult = regenerateIndexSkill(workspaceRoot);
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    }
  }

  const rawOutput = reviewed ? finalBody : firstReport;
  const rendered = renderResearchResult(
    { rawOutput, failureMessage, reasoningSummary: result.reasoningSummary },
    { topic, intensity, savedFile, reviewed, verificationNote, saveError, indexResult }
  );

  const payload = {
    status: result.status,
    threadId: result.threadId,
    topic,
    intensity,
    reviewed,
    rawOutput,
    savedFile,
    answerFile: result.answerFile ?? null,
    diagnostic: result.diagnostic ?? null,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `Research on ${shorten(topic, 60)} finished.`)),
    jobTitle: "Antigravity Research",
    jobClass: "research"
  };
}

function buildAnalysePlanPrompt({ planText, affectedContext, focusText }) {
  const template = loadPromptTemplate(ROOT_DIR, "analyse-plan");
  return interpolateTemplate(template, {
    PLAN_TEXT: planText || "(no plan text provided)",
    AFFECTED_FILE_CONTEXT:
      affectedContext && affectedContext.trim()
        ? affectedContext
        : "(no inline file context provided — read the affected files from the repository as needed)",
    USER_FOCUS: focusText || "No extra focus provided."
  });
}

async function executeAnalysePlanRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAntigravityAvailable(request.cwd);

  const planText = String(request.planText ?? "").trim();
  if (!planText) {
    throw new Error("No plan text to analyse. Pass --plan-file <path> or pipe the plan on stdin.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    prompt: buildAnalysePlanPrompt({
      planText,
      affectedContext: request.affectedContext,
      focusText: request.focusText
    }),
    model: request.model,
    sandbox: "read-only",
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage, reasoningSummary: result.reasoningSummary },
    { title: "Antigravity Plan Analysis", jobId: request.jobId ?? null, write: false }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    answerFile: result.answerFile ?? null,
    diagnostic: result.diagnostic ?? null,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, "Plan analysis finished.")),
    jobTitle: "Antigravity Plan Analysis",
    jobClass: "analyse-plan"
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Antigravity Review" : `Antigravity ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Antigravity Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Antigravity Resume" : "Antigravity Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /agy:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (kind === "research") {
    return "research";
  }
  if (kind === "analyse-plan") {
    return "analyse-plan";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function buildResearchJob(workspaceRoot, topic) {
  return createCompanionJob({
    prefix: "research",
    kind: "research",
    title: "Antigravity Research",
    workspaceRoot,
    jobClass: "research",
    summary: shorten(topic)
  });
}

function buildResearchRequest({ cwd, model, intensity, topic, save, jobId }) {
  return { cwd, model, intensity, topic, save, jobId };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "agy-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Persist the job record (including the `request` the detached worker
  // re-reads) BEFORE spawning the worker. Otherwise a fast-booting worker — or a
  // parent whose write is delayed by state-lock contention — can look up its job
  // before the record exists on disk and die with "No stored job found". The
  // worker fills in its own pid when it flips to running; we still record the
  // spawned worker's pid in the index afterwards so cancelling a still-queued
  // job can terminate it.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  if (child.pid != null) {
    // Index-only, shallow-merged pid patch: it updates just the pid and never
    // overwrites a status the worker may have already written when it started.
    upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureAntigravityAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleResearch(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["intensity", "model", "cwd"],
    booleanOptions: ["json", "background", "wait", "save"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const intensity = resolveIntensity(options.intensity);
  const topic = positionals.join(" ").trim();
  if (!topic) {
    throw new Error("Provide a research topic, e.g. /agy:research <topic>.");
  }
  const save = Boolean(options.save);

  if (options.background) {
    ensureAntigravityAvailable(cwd);
    const job = buildResearchJob(workspaceRoot, topic);
    const request = buildResearchRequest({ cwd, model, intensity, topic, save, jobId: job.id });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildResearchJob(workspaceRoot, topic);
  await runForegroundCommand(
    job,
    (progress) =>
      executeResearchRun({
        cwd,
        model,
        intensity,
        topic,
        save,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleAnalysePlan(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["plan-file", "model", "cwd"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const focusText = positionals.join(" ").trim();

  // The companion stays a pure read-and-run boundary: Claude resolves the plan
  // file (its location is machine/version specific) and passes it via
  // --plan-file; any pre-read affected-file context arrives on stdin.
  let planText = "";
  let affectedContext = "";
  if (options["plan-file"]) {
    planText = fs.readFileSync(path.resolve(cwd, options["plan-file"]), "utf8");
    affectedContext = readStdinIfPiped();
  } else {
    planText = readStdinIfPiped();
  }

  if (!planText.trim()) {
    throw new Error("Provide a plan via --plan-file <path> or piped stdin.");
  }

  const job = createCompanionJob({
    prefix: "analyse-plan",
    kind: "analyse-plan",
    title: "Antigravity Plan Analysis",
    workspaceRoot,
    jobClass: "analyse-plan",
    summary: shorten(focusText || "Plan analysis")
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeAnalysePlanRun({
        cwd,
        model,
        planText,
        affectedContext,
        focusText,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  // Background jobs share one detached worker body; route by the stored job
  // class so a queued research run executes the research path, not the task one.
  const runner = storedJob.jobClass === "research" ? executeResearchRun : executeTaskRun;

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      runner({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Antigravity turn interrupt for ${turnId} on ${threadId}.`
        : `Antigravity turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "research":
      await handleResearch(argv);
      break;
    case "analyse-plan":
      await handleAnalysePlan(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
