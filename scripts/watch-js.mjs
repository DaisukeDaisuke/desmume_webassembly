import * as esbuild from "esbuild";

const context = await esbuild.context({
    entryPoints: ["src/app.js"],
    outfile: "public/app.js",
    bundle: true,
    minify: false,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    sourcemap: "inline",
    legalComments: "inline",
    loader: { ".worker.js": "text" },
    logLevel: "info"
});

await context.watch();
console.log("Watching src/**/*.js");
