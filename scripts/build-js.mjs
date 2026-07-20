import * as esbuild from "esbuild";

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
  loader: { ".worker.js": "text" },
  logLevel: "info"
});
