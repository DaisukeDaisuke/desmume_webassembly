import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.js"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: ["chrome120"],
  loader: { ".worker.js": "text" },
  logLevel: "warning"
});
