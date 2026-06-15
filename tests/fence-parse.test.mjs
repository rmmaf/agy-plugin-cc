// Regression test for LANE F13 — robust JSON extraction in parseStructuredOutput.
//
// The structured-output helper must recover a JSON payload even when the model
// wraps it in surrounding prose: a preamble before a code fence, a bare inline
// object between sentences, or trailing commentary after the closing fence.
// Pure prose with no JSON must still yield parsed:null + a non-null parseError,
// and in every case the ORIGINAL rawOutput is preserved verbatim for display.

import assert from "node:assert/strict";
import test from "node:test";

import { parseStructuredOutput } from "../plugins/agy/scripts/lib/agy.mjs";

test("recovers JSON after a prose preamble and a json code fence", () => {
  const raw = 'Here is the review:\n```json\n{"verdict":"approve","findings":[]}\n```';
  const result = parseStructuredOutput(raw);

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { verdict: "approve", findings: [] });
  // rawOutput must be the original text, untouched.
  assert.equal(result.rawOutput, raw);
});

test("recovers a bare inline object surrounded by prose (no fence)", () => {
  const raw = 'Sure!\n{ "ok": true }\nDone.';
  const result = parseStructuredOutput(raw);

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { ok: true });
  assert.equal(result.rawOutput, raw);
});

test("recovers a fenced object even with trailing prose after the closing fence", () => {
  const raw =
    '```json\n{"verdict":"reject","findings":["needs tests"]}\n```\nLet me know if you need anything else.';
  const result = parseStructuredOutput(raw);

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, {
    verdict: "reject",
    findings: ["needs tests"]
  });
  assert.equal(result.rawOutput, raw);
});

test("pure prose with no JSON still yields parsed:null and a parseError", () => {
  const raw = "no json here";
  const result = parseStructuredOutput(raw);

  assert.equal(result.parsed, null);
  assert.notEqual(result.parseError, null);
  assert.ok(
    typeof result.parseError === "string" && result.parseError.length > 0
  );
  // rawOutput is preserved verbatim even on failure.
  assert.equal(result.rawOutput, raw);
});

test("braces inside string literals do not confuse the balanced-brace scan", () => {
  // A "}" inside a JSON string must not prematurely close the object. This
  // guards the string/escape handling of the balanced-brace fallback.
  const raw = 'Result:\n{ "note": "a closing brace } in text", "ok": true }\nthanks';
  const result = parseStructuredOutput(raw);

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, {
    note: "a closing brace } in text",
    ok: true
  });
  assert.equal(result.rawOutput, raw);
});
