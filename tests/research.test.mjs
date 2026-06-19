import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  buildResearchPrompt,
  buildVerificationPrompt,
  formatPrintTimeout,
  INTENSITY_PRESETS,
  parseGoDurationSeconds,
  parseVerificationOutput,
  resolveIntensity
} from "../plugins/agy/scripts/lib/research-prompts.mjs";
import {
  kbDir,
  kbSkillDir,
  listKbEntries,
  regenerateIndexSkill,
  slugifyTopic,
  writeKbEntry
} from "../plugins/agy/scripts/lib/knowledge-base.mjs";
import { getConfig, setConfig } from "../plugins/agy/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "agy", "scripts", "agy-companion.mjs");
const PLAN_RESEARCH_HOOK = path.join(ROOT, "plugins", "agy", "scripts", "plan-research-hook.mjs");

// ---------------------------------------------------------------------------
// research-prompts.mjs
// ---------------------------------------------------------------------------

test("resolveIntensity defaults to medium and rejects unknown values", () => {
  assert.equal(resolveIntensity(undefined), "medium");
  assert.equal(resolveIntensity(""), "medium");
  assert.equal(resolveIntensity("HIGH"), "high");
  assert.equal(resolveIntensity("low"), "low");
  assert.throws(() => resolveIntensity("ludicrous"), /Unsupported research intensity/);
});

test("formatPrintTimeout renders Go duration strings", () => {
  assert.equal(formatPrintTimeout(180), "3m0s");
  assert.equal(formatPrintTimeout(480), "8m0s");
  assert.equal(formatPrintTimeout(1200), "20m0s");
  assert.equal(formatPrintTimeout(65), "1m5s");
});

test("parseGoDurationSeconds round-trips formatPrintTimeout and parses common shapes", () => {
  assert.equal(parseGoDurationSeconds("20m0s"), 1200);
  assert.equal(parseGoDurationSeconds("3m0s"), 180);
  assert.equal(parseGoDurationSeconds("30m"), 1800);
  assert.equal(parseGoDurationSeconds("1h"), 3600);
  assert.equal(parseGoDurationSeconds("1800s"), 1800);
  assert.equal(parseGoDurationSeconds("1800"), 1800); // bare number = seconds
  assert.equal(parseGoDurationSeconds(""), null);
  assert.equal(parseGoDurationSeconds("garbage"), null);
});

test("buildResearchPrompt embeds the recipe blocks, topic, and intensity source target", () => {
  const prompt = buildResearchPrompt({ topic: "vector databases for RAG", intensity: "high" });
  for (const block of [
    "<task>",
    "<research_mode>",
    "<structured_output_contract>",
    "<citation_rules>",
    "<grounding_rules>"
  ]) {
    assert.ok(prompt.includes(block), `missing ${block}`);
  }
  assert.ok(prompt.includes("vector databases for RAG"));
  assert.ok(prompt.includes(INTENSITY_PRESETS.high.sources));
});

test("buildResearchPrompt requires a topic", () => {
  assert.throws(() => buildResearchPrompt({ topic: "   " }), /topic is required/);
});

test("buildVerificationPrompt carries the VERIFIED/CORRECTED contract and the source report", () => {
  const prompt = buildVerificationPrompt({ topic: "x", firstReport: "ORIGINAL REPORT BODY" });
  assert.ok(prompt.includes("VERIFIED:"));
  assert.ok(prompt.includes("CORRECTED:"));
  assert.ok(prompt.includes("<verification_loop>"));
  assert.ok(prompt.includes("ORIGINAL REPORT BODY"));
});

test("parseVerificationOutput splits the marker from the report body", () => {
  assert.deepEqual(parseVerificationOutput("VERIFIED: looks good\nThe report"), {
    status: "verified",
    note: "looks good",
    body: "The report"
  });

  const corrected = parseVerificationOutput("CORRECTED: fixed citation [2]\n# Report\nbody");
  assert.equal(corrected.status, "corrected");
  assert.equal(corrected.note, "fixed citation [2]");
  assert.ok(corrected.body.includes("# Report"));

  const unmarked = parseVerificationOutput("no marker here");
  assert.equal(unmarked.status, "unmarked");
  assert.equal(unmarked.body, "no marker here");
});

// ---------------------------------------------------------------------------
// knowledge-base.mjs
// ---------------------------------------------------------------------------

test("slugifyTopic produces filesystem-safe, bounded slugs", () => {
  assert.equal(slugifyTopic("Vector Databases & RAG!"), "vector-databases-rag");
  assert.equal(slugifyTopic("   "), "research");
  assert.ok(slugifyTopic("a".repeat(80)).length <= 60);
});

test("slugifyTopic gives purely non-ASCII topics distinct, stable slugs (no 'research' collision)", () => {
  const cjk1 = slugifyTopic("ベクトルデータベース");
  const cjk2 = slugifyTopic("向量数据库");
  assert.match(cjk1, /^research-[0-9a-f]{8}$/);
  assert.match(cjk2, /^research-[0-9a-f]{8}$/);
  assert.notEqual(cjk1, cjk2, "distinct non-ASCII topics must not collide on the same slug");
  assert.equal(slugifyTopic("ベクトルデータベース"), cjk1, "the slug must be stable for the same topic");
});

test("writeKbEntry writes the locked frontmatter and is idempotent per topic", () => {
  const repo = makeTempDir();
  const first = writeKbEntry(repo, {
    topic: "Caching strategies",
    intensity: "medium",
    reviewed: false,
    body: "first body",
    created: "2026-06-18"
  });

  assert.ok(first.file.startsWith(kbDir(repo)));
  const text = fs.readFileSync(first.file, "utf8");
  assert.match(text, /^---\r?\n/);
  assert.match(text, /title: "Caching strategies"/);
  assert.match(text, /topic: "Caching strategies"/);
  assert.match(text, /created: 2026-06-18/);
  assert.match(text, /intensity: medium/);
  assert.match(text, /reviewed: false/);
  assert.match(text, /source: agy/);
  assert.match(text, /first body/);

  // Re-researching the same topic overwrites the same slug rather than piling up.
  const second = writeKbEntry(repo, {
    topic: "Caching strategies",
    intensity: "high",
    reviewed: true,
    body: "second body"
  });
  assert.equal(second.slug, first.slug);
  const files = fs.readdirSync(kbDir(repo)).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 1);
  const updated = fs.readFileSync(second.file, "utf8");
  assert.match(updated, /reviewed: true/);
  assert.match(updated, /second body/);

  const entries = listKbEntries(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Caching strategies");
  assert.equal(entries[0].reviewed, true);
});

test("regenerateIndexSkill writes an index skill that links each entry relatively", () => {
  const repo = makeTempDir();
  writeKbEntry(repo, { topic: "Topic One", intensity: "low", reviewed: false, body: "b1" });
  writeKbEntry(repo, { topic: "Topic Two", intensity: "low", reviewed: true, body: "b2" });

  const { skillFile, count } = regenerateIndexSkill(repo);
  assert.equal(count, 2);
  assert.ok(skillFile.startsWith(kbSkillDir(repo)));

  const text = fs.readFileSync(skillFile, "utf8");
  assert.match(text, /name: agy-knowledge-base/);
  assert.match(text, /Topic One/);
  assert.match(text, /Topic Two/);
  // Link target climbs out of .claude/skills/agy-knowledge-base/ into .claude/agy-knowledge-base/.
  assert.match(text, /\]\(\.\.\/\.\.\/agy-knowledge-base\/topic-one\.md\)/);
});

test("regenerateIndexSkill escapes brackets in entry titles so Markdown links don't break", () => {
  const repo = makeTempDir();
  writeKbEntry(repo, { topic: "Arrays [advanced]", intensity: "low", reviewed: false, body: "b" });
  const { skillFile } = regenerateIndexSkill(repo);
  const text = fs.readFileSync(skillFile, "utf8");
  // Title brackets must be backslash-escaped in the link text.
  assert.match(text, /- \[Arrays \\\[advanced\\\]\]\(/);
});

// ---------------------------------------------------------------------------
// state.mjs config defaults
// ---------------------------------------------------------------------------

test("state config exposes the research flag defaults (all false)", () => {
  const repo = makeTempDir();
  const config = getConfig(repo);
  assert.equal(config.saveResearch, false);
  assert.equal(config.saveReviewedResearch, false);
  assert.equal(config.researchBeforePlan, false);
  assert.equal(config.researchWhilePlan, false);
});

// ---------------------------------------------------------------------------
// setup command flag handling (spawns the companion)
// ---------------------------------------------------------------------------

test("setup --enable-save-research persists and reports the flag", () => {
  const repo = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() };
  const result = run(process.execPath, [COMPANION, "setup", "--enable-save-research", "--json", "--cwd", repo], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.saveResearchEnabled, true);
});

test("setup rejects conflicting research flag pairs", () => {
  const repo = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() };
  const result = run(
    process.execPath,
    [COMPANION, "setup", "--enable-save-research", "--disable-save-research", "--json", "--cwd", repo],
    { cwd: repo, env }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --enable-save-research or --disable-save-research/);
});

// ---------------------------------------------------------------------------
// plan-research-hook.mjs
// ---------------------------------------------------------------------------

test("plan-research hook stays silent when both flags are off", () => {
  const repo = makeTempDir();
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() };
  const result = run(process.execPath, [PLAN_RESEARCH_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "s1", prompt: "do something" })
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("plan-research hook injects guidance once per session when a flag is on", () => {
  const repo = makeTempDir();
  const pluginData = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    setConfig(repo, "researchBeforePlan", true);
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
    const input = JSON.stringify({ cwd: repo, session_id: "sess-1", prompt: "build a feature" });

    const first = run(process.execPath, [PLAN_RESEARCH_HOOK], { cwd: repo, env, input });
    assert.equal(first.status, 0, first.stderr);
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(payload.hookSpecificOutput.additionalContext, /research-before-plan/i);

    // The once-per-session marker suppresses a second injection.
    const second = run(process.execPath, [PLAN_RESEARCH_HOOK], { cwd: repo, env, input });
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), "");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
