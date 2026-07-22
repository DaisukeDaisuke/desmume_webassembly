import { readFile } from "node:fs/promises";

const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const [name, version] of Object.entries(packageJson.dependencies || {})) {
  if (lock.packages?.["node_modules/" + name]?.version !== version) {
    throw new Error(`Production dependency is not exactly locked: ${name}@${version}`);
  }
}
for (const required of ["coi-serviceworker", "esbuild", "terser", "Acorn 8.17.0", "ssim.js 3.5.0", "MIT License text"]) {
  if (!notices.includes(required)) throw new Error(`Missing third-party notice: ${required}`);
}
