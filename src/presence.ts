import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Tells the daemon which repositories this editor has open, so the phone's
// "From your editor" picker and the task queue can route runs here. Only the
// https form of the origin remote is sent — never a local path.

const HEARTBEAT_MS = 30_000;

export interface OpenRepo {
  readonly name: string;
  readonly remoteUrl: string;
  readonly folder: vscode.Uri;
}

/** The `[remote "origin"] url = …` of a git config, or undefined. */
export function parseRemoteUrl(config: string): string | undefined {
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
  const url = section && /^\s*url\s*=\s*(.+)$/m.exec(section[1] ?? '');
  return url?.[1]?.trim();
}

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://…` → `https://github.com/o/r`. */
export function normalizeToHttps(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/.exec(trimmed);
  if (scp && !/^https?:/i.test(trimmed)) {return `https://${scp[1]}/${scp[2]}`;}
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (ssh) {return `https://${ssh[1]}/${ssh[2]}`;}
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (https) {return `https://${https[1]}/${https[2]}`;}
  return undefined;
}

/** The daemon rejects a heartbeat with more entries than this. */
const MAX_REPOS = 50;
/** Subfolders never worth looking into for a nested checkout. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'vendor', 'Pods']);

/**
 * The git config of a checkout rooted at `dir`, or undefined. Handles a worktree,
 * whose `.git` is a file (`gitdir: …/.git/worktrees/<name>`) pointing at the
 * main repository, which holds the shared config.
 */
export function gitConfigPath(dir: string): string | undefined {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) {return path.join(dotGit, 'config');}
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!gitdir) {return undefined;}
    const resolved = path.resolve(dir, gitdir);
    let common = resolved;
    try {
      common = path.resolve(resolved, fs.readFileSync(path.join(resolved, 'commondir'), 'utf8').trim());
    } catch {
      /* not a worktree gitdir (e.g. a submodule) — its config sits in the gitdir */
    }
    return path.join(common, 'config');
  } catch {
    return undefined;
  }
}

/** The https origin of the checkout rooted at `dir`, or undefined. */
function repoRemote(dir: string): string | undefined {
  const configPath = gitConfigPath(dir);
  if (!configPath) {return undefined;}
  try {
    const remote = parseRemoteUrl(fs.readFileSync(configPath, 'utf8'));
    const remoteUrl = remote && normalizeToHttps(remote);
    return remoteUrl && /^https:\/\//.test(remoteUrl) ? remoteUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The repositories reachable from the open workspace folders that have a
 * GitHub-style origin: each folder that is itself a checkout, and otherwise the
 * checkouts directly inside it — so a window on a folder of repos (`~/code`)
 * offers every repo in it, not none.
 */
export function openRepos(): OpenRepo[] {
  const repos: OpenRepo[] = [];
  const seen = new Set<string>();
  const add = (name: string, dir: string): boolean => {
    const remoteUrl = repoRemote(dir);
    if (remoteUrl && !seen.has(dir)) {
      seen.add(dir);
      repos.push({ name, remoteUrl, folder: vscode.Uri.file(dir) });
    }
    return !!remoteUrl;
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {continue;}
    const root = folder.uri.fsPath;
    if (add(folder.name, root) || fs.existsSync(path.join(root, '.git'))) {continue;}
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        add(entry.name, path.join(root, entry.name));
      }
    }
  }
  return repos.slice(0, MAX_REPOS);
}

export class Presence implements vscode.Disposable {
  readonly clientId = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly getUrl: () => string,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly log: (message: string) => void,
  ) {
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    void this.beat();
    vscode.workspace.onDidChangeWorkspaceFolders(() => void this.beat());
  }

  async beat(): Promise<void> {
    const token = await this.getToken().catch(() => undefined);
    if (!token) {return;}
    try {
      await fetch(`${this.getUrl()}/api/presence/workspaces`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, workspaces: openRepos().map((r) => ({ name: r.name, remoteUrl: r.remoteUrl })) }),
      });
    } catch (err) {
      this.log(`presence heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer) {clearInterval(this.timer);}
  }
}
