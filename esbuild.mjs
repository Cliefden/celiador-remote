import { build, context } from "esbuild";

// One CommonJS bundle for the extension host. The Claude Agent SDK stays
// external: it spawns its bundled `cli.js` by a path relative to its own
// module, which bundling would break. `vsce package --no-dependencies` ships
// node_modules as installed, so the SDK (and its CLI) travel in the VSIX.
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  minify: false,
  external: ["vscode", "@anthropic-ai/claude-agent-sdk"],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
