import { readFile } from "node:fs/promises";

const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
for (const required of ["coi-serviceworker", "esbuild", "terser", "ssim.js 3.5.0", "238ab90f2dd1c6dfe9ab532d5e9da9b541545760fb970fb621398ae84daaacfe"]) {
  if (!notices.includes(required)) throw new Error(`Missing third-party notice: ${required}`);
}
