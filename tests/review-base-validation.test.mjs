import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveReviewTarget } from "../plugins/agy/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeRepoWithCommit() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

test("resolveReviewTarget throws an actionable error for a missing base ref", () => {
  const cwd = makeRepoWithCommit();

  assert.throws(
    () => resolveReviewTarget(cwd, { base: "nope" }),
    (error) => {
      assert.match(error.message, /not found|does not exist/i);
      assert.match(error.message, /nope/);
      // Validation happens BEFORE any git diff plumbing, so no raw git error leaks.
      assert.doesNotMatch(error.message, /merge-base|exit=128|fatal:/);
      return true;
    }
  );
});

test("resolveReviewTarget accepts HEAD as a valid base ref", () => {
  const cwd = makeRepoWithCommit();

  const target = resolveReviewTarget(cwd, { base: "HEAD" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "HEAD");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget accepts an existing default branch as base", () => {
  const cwd = makeRepoWithCommit();

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.ok(target.baseRef);
});

test("resolveReviewTarget accepts a valid commit SHA as base", () => {
  const cwd = makeRepoWithCommit();
  const sha = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  const target = resolveReviewTarget(cwd, { base: sha });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, sha);
});

test("the --base existence check leaves working-tree scope unaffected", () => {
  const cwd = makeRepoWithCommit();
  // Dirty the tree so the auto path has a working-tree decision to make.
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const explicit = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.equal(explicit.mode, "working-tree");
  assert.equal(explicit.explicit, true);

  // auto scope with a dirty tree and no --base still resolves to working-tree
  // (no base validation runs on this path).
  const auto = resolveReviewTarget(cwd, {});
  assert.equal(auto.mode, "working-tree");
  assert.equal(auto.explicit, false);
});

test("the --base existence check leaves the auto/clean-repo default-branch path unaffected", () => {
  const cwd = makeRepoWithCommit();

  // Clean tree, no --base: detectDefaultBranch already validates this path, so
  // the new guard does not interfere and it resolves to the default branch.
  const target = resolveReviewTarget(cwd, {});
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.explicit, false);
});
