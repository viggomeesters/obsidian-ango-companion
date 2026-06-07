import esbuild from "esbuild";
import process from "node:process";

const production = process.env.NODE_ENV === "production";

await esbuild.build({
  banner: {
    js: "/* AnGo Companion for Obsidian - generated bundle */",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "node:child_process", "node:fs", "node:path"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2022",
});
