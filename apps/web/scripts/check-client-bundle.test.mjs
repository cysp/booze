import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  bundleBudgetFailures,
  bundleBudgets,
  measureClientBundle,
} from "./check-client-bundle.mjs";

void describe("bundleBudgetFailures", () => {
  void it("accepts measurements at every limit", () => {
    assert.deepEqual(
      bundleBudgetFailures({
        initialCss: {
          bytes: bundleBudgets.initialCssBytes,
          gzipBytes: bundleBudgets.initialCssGzipBytes,
        },
        initial: {
          bytes: bundleBudgets.initialJavaScriptBytes,
          gzipBytes: bundleBudgets.initialJavaScriptGzipBytes,
        },
        largest: { bytes: bundleBudgets.largestJavaScriptBytes },
        totalFontBytes: bundleBudgets.totalFontBytes,
        totalJavaScriptGzipBytes: bundleBudgets.totalJavaScriptGzipBytes,
      }),
      [],
    );
  });

  void it("reports each independently exceeded budget", () => {
    const failures = bundleBudgetFailures({
      initialCss: {
        bytes: bundleBudgets.initialCssBytes + 1,
        gzipBytes: bundleBudgets.initialCssGzipBytes + 1,
      },
      initial: {
        bytes: bundleBudgets.initialJavaScriptBytes + 1,
        gzipBytes: bundleBudgets.initialJavaScriptGzipBytes + 1,
      },
      largest: { bytes: bundleBudgets.largestJavaScriptBytes + 1 },
      totalFontBytes: bundleBudgets.totalFontBytes + 1,
      totalJavaScriptGzipBytes: bundleBudgets.totalJavaScriptGzipBytes + 1,
    });
    assert.equal(failures.length, 7);
  });
});

void describe("measureClientBundle", () => {
  void it("counts HTML script and module-preload assets once, excluding lazy chunks from initial bytes", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "booze-bundle-test-"));
    context.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    mkdirSync(path.join(directory, "assets"));
    const entry = 'import "./shared.js"; console.log("entry");';
    const shared = 'console.log("shared");';
    const other = 'console.log("other preload");';
    const lazy = 'console.log("loaded on demand");';
    const css = "body { color: black; }";
    for (const [name, contents] of Object.entries({
      "entry.js": entry,
      "shared.js": shared,
      "other.js": other,
      "lazy.js": lazy,
      "style.css": css,
    })) {
      writeFileSync(path.join(directory, "assets", name), contents);
    }
    writeFileSync(
      path.join(directory, "index.html"),
      `
      <script type="module" src="/assets/entry.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/shared.js">
      <link href="/assets/other.js" rel="modulepreload" crossorigin>
      <link rel="modulepreload" href="/assets/shared.js">
      <link rel="modulepreload" href="/assets/entry.js">
      <link rel="stylesheet" href="/assets/style.css">
    `,
    );
    const measurement = measureClientBundle(directory);
    assert.deepEqual(measurement.initial, {
      bytes: Buffer.byteLength(entry + shared + other),
      gzipBytes:
        gzipSync(entry).byteLength + gzipSync(shared).byteLength + gzipSync(other).byteLength,
    });
    assert.equal(
      measurement.totalJavaScriptGzipBytes,
      measurement.initial.gzipBytes + gzipSync(lazy).byteLength,
    );
    assert.deepEqual(measurement.initialCss, {
      bytes: Buffer.byteLength(css),
      gzipBytes: gzipSync(css).byteLength,
    });
  });

  void it("rejects a missing preloaded asset rather than understating initial bytes", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "booze-bundle-test-"));
    context.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    mkdirSync(path.join(directory, "assets"));
    writeFileSync(path.join(directory, "assets", "entry.js"), 'console.log("entry");');
    writeFileSync(path.join(directory, "assets", "style.css"), "body {}");
    writeFileSync(
      path.join(directory, "index.html"),
      `
      <script type="module" src="/assets/entry.js"></script>
      <link rel="modulepreload" href="/assets/missing.js">
      <link rel="stylesheet" href="/assets/style.css">
    `,
    );
    assert.throws(() => measureClientBundle(directory), /initial JavaScript asset.*missing/u);
  });
});
