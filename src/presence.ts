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

/** The repositories of the open workspace folders that have a GitHub-style origin. */
export function openRepos(): OpenRepo[] {
  const repos: OpenRepo[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const config = fs.readFileSync(path.join(folder.uri.fsPath, '.git', 'config'), 'utf8');
      const remote = parseRemoteUrl(config);
      const remoteUrl = remote && normalizeToHttps(remote);
      if (remoteUrl && /^https:\/\//.test(remoteUrl)) {
        repos.push({ name: folder.name, remoteUrl, folder: folder.uri });
      }
    } catch {
      /* not a git checkout */
    }
  }
  return repos;
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
