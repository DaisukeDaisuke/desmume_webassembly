import * as esbuild from "esbuild";
import { parse } from "acorn";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEPENDENCY_ENTRIES = Object.freeze([
  ["src/dependencies/acorn.entry.js", "src/dependencies/acorn.dependency-source.js", "__desmumeAcorn"],
  ["src/dependencies/ssim.entry.js", "src/dependencies/ssim.dependency-source.js", "__desmumeSsim"]
]);

export async function buildDependencySources() {
  const expectedDependencyHashes = JSON.parse(await readFile("src/dependencies/expected-hashes.json", "utf8"));
  const dependencySources = new Map();
  for (const [entryPoint, sourceModule, globalName] of DEPENDENCY_ENTRIES) {
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
    assertNoDependencyImports(result, entryPoint);
    const sha256 = createHash("sha256").update(source).digest("hex");
    if (expectedDependencyHashes[sourceModule] !== sha256) {
      throw new Error(`${sourceModule} SHA-256 ${sha256} does not match the fixed audited hash`);
    }
    dependencySources.set(resolve(sourceModule), Object.freeze({
      source,
      sha256,
      metafile: result.metafile
    }));
  }
  return dependencySources;
}

function assertNoDependencyImports(result, entryPoint) {
  const imports = Object.entries(result.metafile.outputs)
    .flatMap(([output, metadata]) => (metadata.imports || []).map((item) => ({ output, ...item })));
  if (imports.length) {
    throw new Error(`${entryPoint} dependency bundle retained imports: ${
      imports.map((item) => `${item.path}:${item.kind}`).join(", ")
    }`);
  }
  if (containsDynamicImportExpression(result.outputFiles[0].text)) {
    throw new Error(`${entryPoint} dependency bundle contains dynamic import syntax`);
  }
}

function containsDynamicImportExpression(source) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true
  });
  const pending = [ast];
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "ImportExpression") return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return false;
}
