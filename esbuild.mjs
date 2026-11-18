import { readFileSync } from "fs";
import { build, context } from "esbuild";

// One CommonJS bundle for the extension host. The Claude Agent SDK stays
// external: it is ES modules only (loaded with a dynamic import() at run time)
// and resolves its own files relative to its module. `vsce package` ships the
// production node_modules, so the SDK's JavaScript travels in the VSIX; its
// platform-native CLI does not (see .vscodeignore and src/cli.ts).

// The npm integrity (SRI) of each platform CLI package at the version the
// lockfile pins, so src/cli.ts can verify a downloaded CLI against a hash that
// shipped with the extension rather than one fetched next to the download.
const SDK = "@anthropic-ai/claude-agent-sdk";
const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
const cliIntegrity = {};
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  const name = key.replace(/^node_modules\//, "");
  if (name.startsWith(`${SDK}-`) && entry.version && entry.integrity) {
    cliIntegrity[`${name}@${entry.version}`] = entry.integrity;
  }
}
if (!Object.keys(cliIntegrity).length) {
  throw new Error(`package-lock.json lists no ${SDK}-<platform> packages with an integrity`);
}

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  minify: false,
  external: ["vscode", SDK],
  define: { __CLAUDE_CLI_INTEGRITY__: JSON.stringify(cliIntegrity) },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
