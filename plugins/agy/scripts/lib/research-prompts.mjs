// Research prompt assembly for the `/agy:research` family of commands.
//
// agy has NO native deep-research flag; "deep research" is prompt engineering:
// a topic wrapped in compact XML-tagged blocks (the same "Research Or
// Recommendation" recipe documented in
// skills/gpt-5-4-prompting/references/agy-prompt-recipes.md) plus an intensity
// preset that controls source breadth and the `--print-timeout` budget. These
// blocks are inlined here (not read from the Claude-facing skill docs at
// runtime) so the runtime has a single, testable source of truth — mirroring
// how lib/agy.mjs's runAppServerReview inlines its review prompt.

export const DEFAULT_INTENSITY = "medium";

// Source breadth + per-run timeout budget per intensity tier. timeoutSec feeds
// agy's `--print-timeout`; the companion also raises the hard wall-clock
// (AGY_TIMEOUT_MS) above it so a long high-intensity run is not killed early.
export const INTENSITY_PRESETS = {
  low: { label: "low", sources: "3 to 5", timeoutSec: 180 },
  medium: { label: "medium", sources: "8 to 12", timeoutSec: 480 },
  high: { label: "high", sources: "15 or more", timeoutSec: 1200 }
};

export function resolveIntensity(value) {
  if (value == null || !String(value).trim()) {
    return DEFAULT_INTENSITY;
  }
  const key = String(value).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(INTENSITY_PRESETS, key)) {
    throw new Error(`Unsupported research intensity "${value}". Use one of: low, medium, high.`);
  }
  return key;
}

// Format a seconds budget as a Go duration string (e.g. 1200 -> "20m0s"), the
// shape agy's `--print-timeout` expects.
export function formatPrintTimeout(timeoutSec) {
  const total = Math.max(1, Math.round(Number(timeoutSec) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m${seconds}s`;
}

// Parse a Go-style duration string (e.g. "20m0s", "1800s", "1h", "30m") back to
// seconds. Returns null when the value is empty or unparseable so callers can
// fall back. A bare number is treated as seconds (defensive).
export function parseGoDurationSeconds(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let match;
  let total = 0;
  let matched = false;
  while ((match = re.exec(text))) {
    matched = true;
    const amount = Number(match[1]);
    switch (match[2]) {
      case "h":
        total += amount * 3600;
        break;
      case "m":
        total += amount * 60;
        break;
      case "s":
        total += amount;
        break;
      case "ms":
        total += amount / 1000;
        break;
      default:
        break;
    }
  }
  return matched ? total : null;
}

export function buildResearchPrompt({ topic, intensity = DEFAULT_INTENSITY } = {}) {
  const key = resolveIntensity(intensity);
  const preset = INTENSITY_PRESETS[key];
  const cleanTopic = String(topic ?? "").trim();
  if (!cleanTopic) {
    throw new Error("A research topic is required.");
  }

  return [
    "<role>",
    "You are Antigravity performing deep web research for a software engineering team.",
    "</role>",
    "",
    "<task>",
    "Research the following topic thoroughly using live web sources, then recommend the best path:",
    cleanTopic,
    `Find ${preset.sources} trustworthy, diverse sources (official docs, primary sources, peer-reviewed papers, well-regarded repositories). Triangulate when sources disagree.`,
    "</task>",
    "",
    "<research_mode>",
    "Separate observed facts, reasoned inferences, and open questions.",
    "Prefer breadth first, then go deeper only where the evidence changes the recommendation.",
    "</research_mode>",
    "",
    "<structured_output_contract>",
    "Return a Markdown report with these sections, in order:",
    "1. `## TL;DR` — 3-5 bullets a rushed reader can act on.",
    "2. `## Observed facts` — what the sources directly support, each with a [N] citation.",
    "3. `## Analysis` — reasoned inferences, tradeoffs, and comparisons; keep it tight.",
    "4. `## Recommendation` — the best path and why, with a confidence level (high/medium/low).",
    "5. `## Open questions` — what remains unverified and why.",
    "6. `## References` — numbered list; each entry as `[N] [Title](URL) — author/org, date`.",
    "Put the highest-value findings first. Keep the prose compact.",
    "</structured_output_contract>",
    "",
    "<citation_rules>",
    "Back every important claim with an explicit [N] citation that maps to the References list.",
    "Prefer primary sources over secondary commentary.",
    "Do not fabricate citations, URLs, titles, or dates.",
    "</citation_rules>",
    "",
    "<grounding_rules>",
    "Ground every claim in a cited source or label it as an inference.",
    "Do not present inferences as facts; mark hypotheses clearly.",
    "Do NOT state release dates, version numbers, prices, or benchmarks unless a cited source directly supports them — never infer or extrapolate them, and never present an unreleased item as already shipped. Mark any unconfirmed specific as `[UNVERIFIED]`.",
    "</grounding_rules>"
  ].join("\n");
}

export function buildVerificationPrompt({ topic, firstReport } = {}) {
  const cleanTopic = String(topic ?? "").trim();
  const report = String(firstReport ?? "").trim();
  if (!report) {
    throw new Error("A first report is required to verify.");
  }

  return [
    "<role>",
    "You are Antigravity fact-checking a research report another model produced.",
    "</role>",
    "",
    "<task>",
    `Verify the research report below about: ${cleanTopic || "the stated topic"}.`,
    "Check every factual claim and every citation. Confirm the cited sources exist and actually support the claims.",
    "</task>",
    "",
    "<verification_loop>",
    "Before finalizing, re-check each claim against its cited source.",
    "If a check fails, correct the claim or remove it; do not pass through known errors.",
    "</verification_loop>",
    "",
    "<grounding_rules>",
    "Only keep claims you can ground in a real, citable source.",
    "Drop or clearly mark any claim you cannot verify as `[UNVERIFIED]`.",
    "</grounding_rules>",
    "",
    "<citation_rules>",
    "Keep the [N] citation style and the References section.",
    "Fix broken, mismatched, or fabricated citations.",
    "</citation_rules>",
    "",
    "<output_contract>",
    "Your FIRST line must be exactly one of:",
    "- `VERIFIED:` followed by a short note, when every claim and citation checks out — then repeat the report UNCHANGED below that line.",
    "- `CORRECTED:` followed by a short note of what you fixed, when you found any factual or citation error — then output the FULL corrected report below that line.",
    "Output only the first-line marker and the report. Keep the same section structure as the source report.",
    "</output_contract>",
    "",
    "<source_material>",
    report,
    "</source_material>"
  ].join("\n");
}

// Split a verification answer into its VERIFIED/CORRECTED marker and the report
// body. Unknown/missing marker => treat as a pass-through of the whole text.
export function parseVerificationOutput(rawOutput) {
  const text = String(rawOutput ?? "");
  const firstLineEnd = text.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
  const rest = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1);

  if (/^VERIFIED:/i.test(firstLine)) {
    return { status: "verified", note: firstLine.slice("VERIFIED:".length).trim(), body: rest.trim() };
  }
  if (/^CORRECTED:/i.test(firstLine)) {
    return { status: "corrected", note: firstLine.slice("CORRECTED:".length).trim(), body: rest.trim() };
  }
  return { status: "unmarked", note: "", body: text.trim() };
}
