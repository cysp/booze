/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- Node executes this dependency-free bundle gate directly. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

// Reviewed size-regression tripwires, not performance targets. See docs/deployment.md.
export const bundleBudgets = {
  initialCssBytes: 280_000,
  initialCssGzipBytes: 48_000,
  initialJavaScriptBytes: 800_000,
  initialJavaScriptGzipBytes: 250_000,
  largestJavaScriptBytes: 650_000,
  totalFontBytes: 40_000,
  totalJavaScriptGzipBytes: 360_000,
};

export function measureClientBundle(clientDirectory) {
  const assetsDirectory = path.join(clientDirectory, "assets");
  const assetNames = readdirSync(assetsDirectory);
  const assetMeasurements = assetNames.map((file) => {
    const filePath = path.join(assetsDirectory, file);
    const contents = readFileSync(filePath);
    return {
      bytes: statSync(filePath).size,
      file,
      gzipBytes: gzipSync(contents).byteLength,
    };
  });
  const javaScriptFiles = assetMeasurements.filter(({ file }) => file.endsWith(".js"));
  const indexHtml = readFileSync(path.join(clientDirectory, "index.html"), "utf8");
  const initialSources = new Set([
    ...[...indexHtml.matchAll(/<script[^>]+src="\/assets\/([^" ]+\.js)"/gu)].map(
      (match) => match[1],
    ),
    ...[
      ...indexHtml.matchAll(
        /<link\b(?=[^>]*\brel="modulepreload")[^>]*\bhref="\/assets\/([^" ]+\.js)"/gu,
      ),
    ].map((match) => match[1]),
  ]);
  if (initialSources.size === 0) {
    throw new Error("Could not identify initial JavaScript assets from dist/client/index.html.");
  }
  const initialFiles = javaScriptFiles.filter(({ file }) => initialSources.has(file));
  if (initialFiles.length !== initialSources.size) {
    throw new Error("An initial JavaScript asset referenced by dist/client/index.html is missing.");
  }
  const initial = {
    bytes: initialFiles.reduce((total, file) => total + file.bytes, 0),
    gzipBytes: initialFiles.reduce((total, file) => total + file.gzipBytes, 0),
  };
  const largest = javaScriptFiles.toSorted((left, right) => right.bytes - left.bytes)[0];
  if (largest === undefined) {
    throw new Error("No client JavaScript assets were built.");
  }
  const initialCssSources = [
    ...indexHtml.matchAll(/<link[^>]+href="\/assets\/([^"]+\.css)"[^>]*>/gu),
  ].map((match) => match[1]);
  const initialCssFiles = assetMeasurements.filter(({ file }) => initialCssSources.includes(file));
  if (initialCssFiles.length === 0) {
    throw new Error("Could not identify initial CSS assets from dist/client/index.html.");
  }
  const initialCss = {
    bytes: initialCssFiles.reduce((total, file) => total + file.bytes, 0),
    gzipBytes: initialCssFiles.reduce((total, file) => total + file.gzipBytes, 0),
  };
  const totalFontBytes = assetMeasurements
    .filter(({ file }) => /\.(?:woff2?|ttf|otf)$/u.test(file))
    .reduce((total, file) => total + file.bytes, 0);
  return {
    initialCss,
    initial,
    largest,
    totalFontBytes,
    totalJavaScriptGzipBytes: javaScriptFiles.reduce((total, file) => total + file.gzipBytes, 0),
  };
}

export function bundleBudgetFailures(measurement) {
  const checks = [
    ["initial CSS", measurement.initialCss.bytes, bundleBudgets.initialCssBytes],
    ["initial CSS gzip", measurement.initialCss.gzipBytes, bundleBudgets.initialCssGzipBytes],
    ["initial JavaScript", measurement.initial.bytes, bundleBudgets.initialJavaScriptBytes],
    [
      "initial JavaScript gzip",
      measurement.initial.gzipBytes,
      bundleBudgets.initialJavaScriptGzipBytes,
    ],
    ["largest JavaScript chunk", measurement.largest.bytes, bundleBudgets.largestJavaScriptBytes],
    ["total fonts", measurement.totalFontBytes, bundleBudgets.totalFontBytes],
    [
      "total JavaScript gzip",
      measurement.totalJavaScriptGzipBytes,
      bundleBudgets.totalJavaScriptGzipBytes,
    ],
  ];
  return checks.flatMap(([label, actual, budget]) =>
    actual > budget ? [`${label}: ${actual} bytes exceeds ${budget} bytes`] : [],
  );
}

if (import.meta.main) {
  const clientDirectory = path.resolve(import.meta.dirname, "../dist/client");
  const measurement = measureClientBundle(clientDirectory);
  const failures = bundleBudgetFailures(measurement);
  process.stdout.write(
    `Client bundle: initial JS ${measurement.initial.bytes} B / ${measurement.initial.gzipBytes} B gzip; initial CSS ${measurement.initialCss.bytes} B / ${measurement.initialCss.gzipBytes} B gzip; largest JS ${measurement.largest.bytes} B; total JS ${measurement.totalJavaScriptGzipBytes} B gzip; fonts ${measurement.totalFontBytes} B.\n`,
  );
  if (failures.length > 0) {
    process.stderr.write(`Bundle budget exceeded:\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
  }
}
