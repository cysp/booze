/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- Node executes this script with its built-in test runner. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const webDirectory = path.resolve(import.meta.dirname, "..");
const artifacts = ["booze.css", "booze.css.d.ts", "booze.js", "booze.d.ts", "booze.variants.d.ts"];

describe("theme:check", () => {
  // Astryx confines generated files to the working directory.
  const directory = mkdtempSync(path.join(webDirectory, ".theme-check-"));
  const generatedDirectory = path.join(directory, "src/generated");

  /** @param {boolean} check */
  function run(check) {
    return spawnSync("pnpm", ["run", check ? "theme:check" : "theme:build"], {
      cwd: directory,
      encoding: "utf8",
    });
  }

  function snapshot() {
    return Object.fromEntries(
      readdirSync(generatedDirectory)
        .toSorted()
        .map((file) => [
          file,
          {
            content: readFileSync(path.join(generatedDirectory, file), "utf8"),
            modified: statSync(path.join(generatedDirectory, file), { bigint: true }).mtimeNs,
          },
        ]),
    );
  }

  before(() => {
    mkdirSync(generatedDirectory, { recursive: true });
    symlinkSync(
      path.join(webDirectory, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    copyFileSync(
      path.join(webDirectory, "src/booze-theme.ts"),
      path.join(directory, "src/booze-theme.ts"),
    );
    const { scripts } = JSON.parse(readFileSync(path.join(webDirectory, "package.json"), "utf8"));
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { "theme:build": scripts["theme:build"], "theme:check": scripts["theme:check"] },
      }),
    );
    const build = run(false);
    assert.equal(build.status, 0, build.stdout + build.stderr);
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts current artifacts without writing them", () => {
    const original = snapshot();
    const check = run(true);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.deepEqual(snapshot(), original);
  });

  for (const artifact of artifacts) {
    for (const change of ["changed", "missing"]) {
      it(`rejects ${change} ${artifact} without writing artifacts`, () => {
        const file = path.join(generatedDirectory, artifact);
        const original = readFileSync(file, "utf8");
        try {
          if (change === "missing") rmSync(file);
          else writeFileSync(file, original + "\n/* unexpected generated content */\n");
          const beforeCheck = snapshot();
          const check = run(true);
          assert.equal(check.status, 1, check.stdout + check.stderr);
          assert.deepEqual(snapshot(), beforeCheck);
        } finally {
          writeFileSync(file, original);
        }
        const restored = run(true);
        assert.equal(restored.status, 0, restored.stdout + restored.stderr);
      });
    }
  }
});
