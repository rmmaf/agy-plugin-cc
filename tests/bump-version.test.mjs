import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture() {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "agy-plugin-cc",
    version: "1.0.2"
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "agy-plugin-cc",
    version: "1.0.2",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "agy-plugin-cc",
        version: "1.0.2"
      }
    }
  });
  writeJson(path.join(root, "plugins", "agy", ".claude-plugin", "plugin.json"), {
    name: "agy",
    version: "1.0.2"
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: {
      version: "1.0.2"
    },
    plugins: [
      {
        name: "agy",
        version: "1.0.2"
      }
    ]
  });

  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "agy", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");
});

test("bump-version tolerates npm v1 lockfiles without a packages object", () => {
  const root = makeVersionFixture();
  // Replace the v3 lockfile with an npm v1 lockfile: it uses `dependencies`
  // and has no top-level `packages` object.
  writeJson(path.join(root, "package-lock.json"), {
    name: "agy-plugin-cc",
    version: "1.0.2",
    lockfileVersion: 1,
    dependencies: {
      "left-pad": {
        version: "1.3.0"
      }
    }
  });

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);

  const lockfile = readJson(path.join(root, "package-lock.json"));
  assert.equal(lockfile.version, "1.2.3");
  // The absent `packages` object is left untouched (still absent).
  assert.equal(Object.prototype.hasOwnProperty.call(lockfile, "packages"), false);
  // The v1 `dependencies` block is preserved as-is.
  assert.deepEqual(lockfile.dependencies, { "left-pad": { version: "1.3.0" } });

  // --check should also succeed against the v1 lockfile without throwing.
  const check = run("node", [SCRIPT, "--root", root, "--check", "1.2.3"], {
    cwd: ROOT
  });
  assert.equal(check.status, 0, check.stderr);
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "agy-plugin-cc",
    version: "1.0.3"
  });

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/agy\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});
