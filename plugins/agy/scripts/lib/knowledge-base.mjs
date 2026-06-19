// Project knowledge-base persistence for the research feature.
//
// Saved research lives in the USER'S repo (committable, discoverable), not in
// the plugin state dir:
//   <repoRoot>/.claude/agy-knowledge-base/<slug>.md   one report per topic
//   <repoRoot>/.claude/skills/agy-knowledge-base/SKILL.md   one index skill
// The index skill is fully regenerated from the entries on every write so its
// description (which drives Claude Code's automatic skill loading) always lists
// the covered topics and links each entry.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { atomicWriteFileSync } from "./state.mjs";

const KB_DIR_NAME = "agy-knowledge-base";
const KB_SKILL_NAME = "agy-knowledge-base";
// Budget for the topic list embedded in the index skill description. Skill
// descriptions have an upper length limit; stay well under it and summarise the
// overflow as "+N more".
const MAX_DESCRIPTION_TOPICS_CHARS = 700;

export function slugifyTopic(topic) {
  const raw = String(topic ?? "").trim();
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = base.slice(0, 60).replace(/-+$/g, "");
  if (trimmed) {
    return trimmed;
  }
  // A purely non-ASCII topic (e.g. Chinese/Japanese/Cyrillic) slugifies to
  // empty. Derive a stable slug from a short hash of the original topic so
  // distinct topics don't all collide on "research" and overwrite each other.
  if (raw) {
    return `research-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
  }
  return "research";
}

export function kbDir(repoRoot) {
  return path.join(repoRoot, ".claude", KB_DIR_NAME);
}

export function kbSkillDir(repoRoot) {
  return path.join(repoRoot, ".claude", "skills", KB_SKILL_NAME);
}

function escapeYamlDoubleQuoted(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function todayDate() {
  // Date-only stamp. The companion runs as an ordinary Node process, so the
  // Date API is available here (unlike workflow scripts).
  return new Date().toISOString().slice(0, 10);
}

export function writeKbEntry(repoRoot, { topic, intensity, reviewed, body, created } = {}) {
  const dir = kbDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugifyTopic(topic);
  const file = path.join(dir, `${slug}.md`);
  const frontmatter = [
    "---",
    `title: "${escapeYamlDoubleQuoted(topic)}"`,
    `topic: "${escapeYamlDoubleQuoted(topic)}"`,
    `created: ${created || todayDate()}`,
    `intensity: ${intensity || "medium"}`,
    `reviewed: ${reviewed ? "true" : "false"}`,
    "source: agy",
    "---"
  ].join("\n");
  const content = `${frontmatter}\n\n${String(body ?? "").trim()}\n`;
  atomicWriteFileSync(file, content);
  return { file, slug };
}

function parseEntryFrontmatter(text) {
  const meta = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    return meta;
  }
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    meta[m[1]] = value;
  }
  return meta;
}

export function listKbEntries(repoRoot) {
  const dir = kbDir(repoRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const file = path.join(dir, name);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const meta = parseEntryFrontmatter(text);
    const slug = name.replace(/\.md$/, "");
    entries.push({
      slug,
      file,
      title: meta.title || slug,
      topic: meta.topic || meta.title || slug,
      created: meta.created || "",
      intensity: meta.intensity || "",
      reviewed: meta.reviewed === "true"
    });
  }
  entries.sort((left, right) => left.slug.localeCompare(right.slug));
  return entries;
}

function buildTopicSummary(entries) {
  const titles = entries.map((entry) => entry.title).filter(Boolean);
  const kept = [];
  for (const title of titles) {
    const candidate = kept.concat(title).join("; ");
    if (kept.length > 0 && candidate.length > MAX_DESCRIPTION_TOPICS_CHARS) {
      break;
    }
    kept.push(title);
  }
  let summary = kept.join("; ");
  const omitted = titles.length - kept.length;
  if (omitted > 0) {
    summary = `${summary}; +${omitted} more`;
  }
  return summary || "project research";
}

export function regenerateIndexSkill(repoRoot) {
  const entries = listKbEntries(repoRoot);
  const dir = kbSkillDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");

  const description =
    `Project knowledge base researched with Antigravity (agy). Covers: ${buildTopicSummary(entries)}. ` +
    "Use when the user asks about any of these topics or needs project/domain background, prior research, or technology comparisons already gathered for this repository.";

  const lines = [
    "---",
    "name: agy-knowledge-base",
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "# Project knowledge base (agy research)",
    "",
    "Deep-research reports gathered for this project with `/agy:research` and `/agy:generate-knowledge-base`.",
    "Consult the relevant entry before planning or implementing work in its area.",
    ""
  ];

  if (entries.length === 0) {
    lines.push("_No knowledge-base entries yet._");
  } else {
    lines.push("## Entries", "");
    for (const entry of entries) {
      const created = entry.created ? ` — ${entry.created}` : "";
      const reviewed = entry.reviewed ? " (reviewed)" : "";
      // Escape brackets so a title containing [ or ] can't break the Markdown link.
      const safeTitle = String(entry.title).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      lines.push(`- [${safeTitle}](../../${KB_DIR_NAME}/${entry.slug}.md)${created}${reviewed}`);
    }
  }

  atomicWriteFileSync(skillFile, `${lines.join("\n").trimEnd()}\n`);
  return { skillFile, count: entries.length };
}
