import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Doc/source consistency guard.
//
// These tests pin the CURRENT (post-fix) state of the docs and packaging so
// that the F03 (CI), F14 (README org), and "@openai/codex" packaging residue
// defects can never silently regress, and so that every companion subcommand
// named in commands/skills/agents actually exists in the companion runtime.
//
// They are characterization tests: each assertion encodes the value the repo
// holds TODAY (after the L6 fixes), so `npm test` stays green. Where the value
// differs from the historical Codex-era residue the defect described, a
// "// BUG Fxx" comment records what the buggy value WAS vs. what is correct.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy");
const COMMANDS_DIR = path.join(PLUGIN_ROOT, "commands");
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");
const AGENTS_DIR = path.join(PLUGIN_ROOT, "agents");
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "agy-companion.mjs");

function read(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

function listFilesRecursive(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function allDocFiles() {
  const isMd = (p) => p.endsWith(".md");
  return [
    path.join(ROOT, "README.md"),
    ...listFilesRecursive(COMMANDS_DIR, isMd),
    ...listFilesRecursive(SKILLS_DIR, isMd),
    ...listFilesRecursive(AGENTS_DIR, isMd)
  ];
}

// Subcommands the companion dispatcher actually accepts, parsed straight from
// the `case "<name>":` arms of its switch statement so the test tracks the real
// runtime surface rather than a hand-maintained list.
function companionSubcommands() {
  const source = read(COMPANION);
  const cases = new Set();
  for (const match of source.matchAll(/case\s+"([a-z][a-z-]*)":/g)) {
    cases.add(match[1]);
  }
  return cases;
}

test("companion exposes the subcommands the commands route to", () => {
  const subs = companionSubcommands();
  // Sanity: the dispatcher must at least expose the user-facing entrypoints.
  for (const expected of [
    "setup",
    "review",
    "adversarial-review",
    "task",
    "status",
    "result",
    "cancel",
    "task-resume-candidate"
  ]) {
    assert.ok(subs.has(expected), `companion is missing subcommand "${expected}"`);
  }
});

test("every agy-companion subcommand named in docs exists in the companion", () => {
  const subs = companionSubcommands();
  const referenceRe = /agy-companion\.mjs"\s+([a-z][a-z-]*)/g;
  const seen = new Set();
  for (const file of allDocFiles()) {
    const text = read(file);
    for (const match of text.matchAll(referenceRe)) {
      const sub = match[1];
      seen.add(sub);
      assert.ok(
        subs.has(sub),
        `${path.relative(ROOT, file)} references companion subcommand "${sub}" which is not implemented`
      );
    }
  }
  // The docs really do reference companion subcommands (guards against the regex
  // silently matching nothing if the invocation format ever changes).
  assert.ok(seen.size > 0, "expected at least one agy-companion subcommand reference in docs");
});

test("no docs point the marketplace/install at the wrong org", () => {
  // BUG F14: README.md:26 used `openai/agy-plugin-cc` (Codex residue); the real
  // origin is `rmmaf/agy-plugin-cc`. Pin that no doc references the openai org.
  for (const file of allDocFiles()) {
    const text = read(file);
    assert.doesNotMatch(
      text,
      /openai\/[\w-]+/i,
      `${path.relative(ROOT, file)} references the openai/ org; this plugin's origin is rmmaf/agy-plugin-cc`
    );
  }
});

test("README points the marketplace at rmmaf/agy-plugin-cc", () => {
  const readme = read(path.join(ROOT, "README.md"));
  // BUG F14: current/correct value is rmmaf/agy-plugin-cc; the buggy value was
  // openai/agy-plugin-cc.
  assert.match(readme, /\/plugin marketplace add rmmaf\/agy-plugin-cc/);
});

test("docs describe --effort as accepted-but-ignored, not a Codex reasoning knob", () => {
  // The agy backend ignores --effort. Pin the consistent wording in the README
  // and the rescue command so the no-op contract is not re-described as active.
  const readme = read(path.join(ROOT, "README.md"));
  const rescue = read(path.join(COMMANDS_DIR, "rescue.md"));
  assert.match(
    readme,
    /the `--effort` flag is accepted but currently ignored by the agy backend/i
  );
  assert.match(rescue, /`--effort` is currently accepted but ignored by the Antigravity backend/i);
  // The --effort argument hint still advertises the same value set the companion
  // validates (none|minimal|low|medium|high).
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high>/);
});

test("docs tell users to list models with `agy models`, not `codex`", () => {
  const readme = read(path.join(ROOT, "README.md"));
  const rescue = read(path.join(COMMANDS_DIR, "rescue.md"));
  assert.match(readme, /List the model names you can pass to `--model` with `agy models`/i);
  assert.match(rescue, /list available models with `agy models`/i);
  // BUG: Codex-era docs said `codex models`; the agy port must reference `agy
  // models`. Guard against the codex model command leaking back in.
  for (const text of [readme, rescue]) {
    assert.doesNotMatch(text, /`codex models`/i);
  }
});

test("packaging names use the agy plugin name, not the @openai/codex name", () => {
  const pkg = JSON.parse(read(path.join(ROOT, "package.json")));
  const lock = JSON.parse(read(path.join(ROOT, "package-lock.json")));
  // BUG (packaging residue): the name was reported as `@openai/codex-plugin-cc`;
  // the correct name is `agy-plugin-cc`.
  assert.equal(pkg.name, "agy-plugin-cc");
  assert.equal(lock.name, "agy-plugin-cc");
  assert.equal(lock.packages?.[""]?.name, "agy-plugin-cc");
});
