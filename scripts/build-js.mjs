import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const bundledWorkers = new Map();
for (const entryPoint of [
  "src/workers/eval.worker.js",
  "src/workers/persistent-script.worker.js",
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
      build.onLoad({ filter: /\.worker\.js$/ }, async ({ path }) => ({
        contents: bundledWorkers.get(resolve(path)) ?? await readFile(path, "utf8"),
        loader: "text"
      }));
    }
  }],
  logLevel: "info"
});
