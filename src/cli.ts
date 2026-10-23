/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

// Where the Claude Code CLI comes from. The Agent SDK normally finds it in a
// platform package (@anthropic-ai/claude-agent-sdk-<os>-<arch>, ~270 MB), which
// is too big to ship in a VSIX. So, in order: that package when it is present
// (development), the exact version downloaded earlier into global storage, a
// `claude` already installed on this machine, and finally a one-time download
// of the exact version from the npm registry.

const SDK = '@anthropic-ai/claude-agent-sdk';
const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']);

function binaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function exists(file: string): boolean {
  try {return fs.statSync(file).isFile();} catch {return false;}
}

/** The SDK version this build was installed with, read from its package.json. */
function sdkVersion(extensionPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'node_modules', SDK, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
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

async function download(url: string, target: string, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<void> {
  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  const res = await fetch(url, { signal: ac.signal });
  if (!res.ok || !res.body) {throw new Error(`download failed: HTTP ${res.status}`);}
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPercent = 0;
  const out = fs.createWriteStream(target);
  try {
    for await (const chunk of res.body) {
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
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
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
    const version = sdkVersion(extensionPath);
    // 1. The SDK's platform package, when a development install has it.
    if (pkg) {
      const bundled = path.join(extensionPath, 'node_modules', pkg, binaryName());
      if (exists(bundled)) {return undefined;} // the SDK finds this one itself
    }
    // 2. The exact version downloaded earlier.
    const storage = this.context.globalStorageUri.fsPath;
    const downloaded = version ? path.join(storage, 'claude', version, binaryName()) : undefined;
    if (downloaded && exists(downloaded)) {return downloaded;}
    // 3. A claude already on this machine.
    const installed = await installedClaude();
    if (installed) {
      this.log(`using the installed Claude Code at ${installed}`);
      return installed;
    }
    // 4. Download the exact version, once.
    if (!pkg || !version || !downloaded) {
      throw new Error(`no Claude Code CLI found and no download available for ${process.platform}-${process.arch}; install Claude Code (https://claude.com/claude-code) and reload`);
    }
    const url = `https://registry.npmjs.org/${pkg}/-/${pkg.slice(SDK.lastIndexOf('/') + 1)}-${version}.tgz`;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Celiador: downloading Claude Code (once, about 270 MB)', cancellable: true }, async (progress, token) => {
      const dir = path.dirname(downloaded);
      fs.mkdirSync(dir, { recursive: true });
      const tgz = path.join(dir, 'package.tgz');
      await download(url, tgz, progress, token);
      progress.report({ message: 'unpacking' });
      await run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1', `package/${binaryName()}`], 300_000);
      fs.rmSync(tgz, { force: true });
      if (process.platform !== 'win32') {fs.chmodSync(downloaded, 0o755);}
    });
    if (!exists(downloaded)) {throw new Error('the Claude Code download did not produce an executable');}
    this.log(`downloaded Claude Code ${version} to ${downloaded}`);
    return downloaded;
  }
}
