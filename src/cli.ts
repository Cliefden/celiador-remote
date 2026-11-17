/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';

// Where the Claude Code CLI comes from. The Agent SDK normally finds it in a
// platform package (@anthropic-ai/claude-agent-sdk-<os>-<arch>, ~270 MB), which
// is too big to ship in a VSIX. So, in order: that package when it is present
// (development), the exact version downloaded earlier into global storage, a
// `claude` installed on this machine when it is the version the SDK pins, a
// one-time download of that exact version from the npm registry (verified
// against the package's integrity hash), and only when that download is not
// possible, an installed `claude` of another version.

const SDK = '@anthropic-ai/claude-agent-sdk';

/** `<package>@<version>` → npm integrity (SRI), from package-lock.json at build time (esbuild.mjs). */
declare const __CLAUDE_CLI_INTEGRITY__: Record<string, string>;
const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']);

function binaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function exists(file: string): boolean {
  try {return fs.statSync(file).isFile();} catch {return false;}
}

/** The SDK version this build was installed with, and the Claude Code version it pins, from its package.json. */
function sdkInfo(extensionPath: string): { version?: string; claudeCodeVersion?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'node_modules', SDK, 'package.json'), 'utf8')) as { version?: unknown; claudeCodeVersion?: unknown };
    return {
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      claudeCodeVersion: typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : undefined,
    };
  } catch {
    return {};
  }
}

/** The sha512 digests (base64) an SRI string allows; npm publishes `sha512-<base64>`. */
export function sha512Digests(integrity: string): string[] {
  return integrity.split(/\s+/).filter((part) => part.startsWith('sha512-')).map((part) => part.slice('sha512-'.length).replace(/\?.*$/, ''));
}

/**
 * The integrity the downloaded tarball must match: the one shipped with this
 * build (package-lock.json), else the registry's `dist.integrity` for that
 * exact version. Both present and different is an error.
 */
async function expectedIntegrity(pkg: string, version: string, log: (message: string) => void): Promise<string> {
  const pinned = typeof __CLAUDE_CLI_INTEGRITY__ === 'object' ? __CLAUDE_CLI_INTEGRITY__[`${pkg}@${version}`] : undefined;
  let published: string | undefined;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const meta = await res.json() as { dist?: { integrity?: unknown } };
      published = typeof meta.dist?.integrity === 'string' ? meta.dist.integrity : undefined;
    }
  } catch (err) {
    log(`registry metadata for ${pkg}@${version}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pinned && published && pinned !== published) {
    throw new Error(`the registry's integrity for ${pkg}@${version} does not match the one this extension was built with`);
  }
  const integrity = pinned ?? published;
  if (!integrity || !sha512Digests(integrity).length) {throw new Error(`no sha512 integrity for ${pkg}@${version}`);}
  if (!pinned) {log(`${pkg}@${version} is not in this build's lockfile; verifying against the registry's integrity`);}
  return integrity;
}

/** The version a `claude` executable reports (`2.1.309 (Claude Code)` → `2.1.309`). */
async function claudeVersion(executable: string): Promise<string | undefined> {
  try {
    return /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(await run(executable, ['--version'], 10_000))?.[0];
  } catch {
    return undefined;
  }
}

function platformPackage(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  return SUPPORTED.has(key) ? `${SDK}-${key}` : undefined;
}

function run(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** A `claude` the user already has: on PATH, or in the usual install locations. */
async function installedClaude(): Promise<string | undefined> {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe')]
    : [path.join(home, '.claude', 'local', 'claude'), path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  try {
    const found = (await run(process.platform === 'win32' ? 'where' : 'which', ['claude'])).split(/\r?\n/)[0]?.trim();
    if (found) {candidates.unshift(found);}
  } catch {
    /* not on PATH */
  }
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) {return candidate;}
  }
  return undefined;
}

/** Downloads `url` to `target`; the file is removed unless its sha512 matches `integrity`. */
async function download(url: string, target: string, integrity: string, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<void> {
  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  const res = await fetch(url, { signal: ac.signal });
  if (!res.ok || !res.body) {throw new Error(`download failed: HTTP ${res.status}`);}
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPercent = 0;
  const hash = createHash('sha512');
  const out = fs.createWriteStream(target);
  let complete = false;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (total) {
        const percent = Math.floor((received / total) * 100);
        if (percent > lastPercent) {
          progress.report({ increment: percent - lastPercent, message: `${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB` });
          lastPercent = percent;
        }
      }
      if (!out.write(chunk)) {await new Promise<void>((resolve) => out.once('drain', resolve));}
    }
    complete = true;
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
    if (!complete) {fs.rmSync(target, { force: true });}
  }
  if (!sha512Digests(integrity).includes(hash.digest('base64'))) {
    fs.rmSync(target, { force: true });
    throw new Error('the downloaded Claude Code package does not match its published integrity hash; nothing was installed');
  }
}

/**
 * The Claude Code executable for agent runs, or undefined to let the SDK use
 * its own lookup. Resolved once per activation and remembered.
 */
export class ClaudeExecutable {
  private resolved: Promise<string | undefined> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: (message: string) => void) {}

  get(): Promise<string | undefined> {
    if (!this.resolved) {
      this.resolved = this.resolve().catch((err) => {
        this.log(`claude executable: ${err instanceof Error ? err.message : String(err)}`);
        this.resolved = undefined;
        return undefined;
      });
    }
    return this.resolved;
  }

  private async resolve(): Promise<string | undefined> {
    const extensionPath = this.context.extensionUri.fsPath;
    const pkg = platformPackage();
    const { version, claudeCodeVersion } = sdkInfo(extensionPath);
    // 1. The SDK's platform package, when a development install has it.
    if (pkg) {
      const bundled = path.join(extensionPath, 'node_modules', pkg, binaryName());
      if (exists(bundled)) {return undefined;} // the SDK finds this one itself
    }
    // 2. The exact version downloaded (and verified) earlier.
    const storage = this.context.globalStorageUri.fsPath;
    const downloaded = version ? path.join(storage, 'claude', version, binaryName()) : undefined;
    if (downloaded && exists(downloaded)) {return downloaded;}
    // 3. A claude already on this machine, when it is the version the SDK pins.
    const installed = await installedClaude();
    const installedVersion = installed ? await claudeVersion(installed) : undefined;
    if (installed && claudeCodeVersion && installedVersion === claudeCodeVersion) {
      this.log(`using the installed Claude Code ${installedVersion} at ${installed}`);
      return installed;
    }
    // 4. Download the exact version, once, verified against its integrity hash.
    if (pkg && version && downloaded) {
      try {
        await this.download(pkg, version, downloaded);
        return downloaded;
      } catch (err) {
        if (!installed) {throw err;}
        this.log(`Claude Code ${version} download failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // 5. An installed claude of another version: better than none, but the SDK may not match it.
    if (installed) {
      this.log(`using the installed Claude Code ${installedVersion ?? '(unknown version)'} at ${installed}; this extension's SDK expects ${claudeCodeVersion ?? 'another version'}`);
      return installed;
    }
    throw new Error(`no Claude Code CLI found and no download available for ${process.platform}-${process.arch}; install Claude Code (https://claude.com/claude-code) and reload`);
  }

  private async download(pkg: string, version: string, downloaded: string): Promise<void> {
    const integrity = await expectedIntegrity(pkg, version, this.log);
    const url = `https://registry.npmjs.org/${pkg}/-/${pkg.slice(SDK.lastIndexOf('/') + 1)}-${version}.tgz`;
    const dir = path.dirname(downloaded);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Celiador: downloading Claude Code (once, about 270 MB)', cancellable: true }, async (progress, token) => {
      fs.mkdirSync(dir, { recursive: true });
      const tgz = path.join(dir, 'package.tgz');
      await download(url, tgz, integrity, progress, token);
      progress.report({ message: 'unpacking' });
      try {
        await run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1', `package/${binaryName()}`], 300_000);
      } finally {
        fs.rmSync(tgz, { force: true });
      }
      if (process.platform !== 'win32') {fs.chmodSync(downloaded, 0o755);}
    });
    if (!exists(downloaded)) {throw new Error('the Claude Code download did not produce an executable');}
    this.log(`downloaded Claude Code ${version} (integrity verified) to ${downloaded}`);
  }
}
