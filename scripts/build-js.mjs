import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const bundledWorkers = new Map();
for (const entryPoint of [
  "src/workers/eval.worker.js",
  "src/workers/eval-supervisor.worker.js",
  "src/workers/persistent-script.worker.js",
  "src/workers/persistent-script-supervisor.worker.js",
  "src/workers/algorithm.worker.js",
  "src/workers/security-boundary.worker.js"
]) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    minify: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    legalComments: "none",
    logLevel: "silent"
  });
  bundledWorkers.set(resolve(entryPoint), result.outputFiles[0].text);
}

const dependencySources = new Map();
for (const [entryPoint, sourceModule, globalName] of [
  ["src/dependencies/acorn.entry.js", "src/dependencies/acorn.dependency-source.js", "__desmumeAcorn"],
  ["src/dependencies/ssim.entry.js", "src/dependencies/ssim.dependency-source.js", "__desmumeSsim"],
  ["src/security-fixtures/adversarial-dependency.entry.js", "src/dependencies/adversarial.dependency-source.js", "__desmumeAdversarial"]
]) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    minify: true,
    platform: "browser",
    format: "iife",
    globalName,
    target: ["chrome120"],
    legalComments: "none",
    logLevel: "silent",
    metafile: true
  });
  const source = `${result.outputFiles[0].text}\n${globalName}`;
  dependencySources.set(resolve(sourceModule), Object.freeze({
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
    metafile: result.metafile
  }));
}

await esbuild.build({
  entryPoints: ["src/app.js"],
  outfile: "public/app.js",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "external",
  plugins: [{
    name: "embedded-workers",
    setup(build) {
      build.onLoad({ filter: /\.dependency-source\.js$/ }, ({ path }) => {
        const dependency = dependencySources.get(resolve(path));
        if (!dependency) throw new Error(`Unknown dependency source module: ${path}`);
        return {
          contents: `export default Object.freeze(${JSON.stringify({ source: dependency.source, sha256: dependency.sha256 })});`,
          loader: "js"
        };
      });
      build.onLoad({ filter: /\.worker\.js$/ }, async ({ path }) => ({
        contents: bundledWorkers.get(resolve(path)) ?? await readFile(path, "utf8"),
        loader: "text"
      }));
    }
  }],
  logLevel: "info"
});

const applicationBundle = await readFile("public/app.js");
await writeFile(
  "public/app.js.sha256",
  `${createHash("sha256").update(applicationBundle).digest("hex")}  app.js\n`,
  "utf8"
);
