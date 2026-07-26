import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDependencySources } from "./dependency-bundle-policy.mjs";

const bundledWorkers = new Map();
for (const entryPoint of [
  "src/workers/parser.worker.js",
  "src/workers/eval.worker.js",
  "src/workers/eval-supervisor.worker.js",
  "src/workers/persistent-script.worker.js",
  "src/workers/persistent-script-supervisor.worker.js",
  "src/workers/algorithm.worker.js"
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

const dependencySources = await buildDependencySources();

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
