import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/agy/scripts/lib/args.mjs";

/*
 * F01 regression coverage.
 *
 * splitRawArgumentString is the lexer used for the single-token "$ARGUMENTS"
 * path that every slash command routes through. A backslash must be a LITERAL
 * character by default (so Windows paths survive) and only act as an escape when
 * it precedes a quote, apostrophe, another backslash, or whitespace.
 */

test("a Windows path keeps its backslashes (F01 fix)", () => {
  assert.deepEqual(
    splitRawArgumentString("--cwd C:\\Users\\me\\proj"),
    ["--cwd", "C:\\Users\\me\\proj"]
  );
});

test("--cwd with a backslash path parses to the intact value", () => {
  const { options } = parseArgs(splitRawArgumentString("--cwd C:\\Users\\me\\proj"), {
    valueOptions: ["cwd"]
  });
  assert.equal(options.cwd, "C:\\Users\\me\\proj");
});

test("a quoted Windows path with spaces survives lexing and parsing", () => {
  const tokens = splitRawArgumentString('--cwd "C:\\Program Files\\My App" --json');
  assert.deepEqual(tokens, ["--cwd", "C:\\Program Files\\My App", "--json"]);
  const { options } = parseArgs(tokens, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  assert.equal(options.cwd, "C:\\Program Files\\My App");
  assert.equal(options.json, true);
});

test("backslash still escapes a quote, apostrophe, backslash, or space", () => {
  assert.deepEqual(splitRawArgumentString('a\\"b'), ['a"b']); // escaped double-quote
  assert.deepEqual(splitRawArgumentString("a\\'b"), ["a'b"]); // escaped apostrophe
  assert.deepEqual(splitRawArgumentString("a\\\\b"), ["a\\b"]); // \\ -> single literal backslash
  assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]); // escaped space joins the token
});

test("a trailing lone backslash stays literal", () => {
  assert.deepEqual(splitRawArgumentString("path\\"), ["path\\"]);
});

test("quotes still group interior whitespace", () => {
  assert.deepEqual(splitRawArgumentString('--model "gpt 5 pro"'), ["--model", "gpt 5 pro"]);
});
