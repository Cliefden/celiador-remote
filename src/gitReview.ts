/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *  Ported from the celiador-ai extension of the Celiador editor; keep the two in step.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { composeTaskPrBody } from './prBody';

// The relay's run-review executor. An agent run's relay client receives `git.*`
// commands from the phone (via the daemon) and delegates here over the
// `celiadorRemote.relayGit` command, which uses the vscode.git extension API:
// status/diff/commit/discard run through the editor's own git machinery
// (honours the user's git config, hooks and credentials), and a pull request is
// opened with the editor's GitHub sign-in (or the gh CLI's).

/** Arguments the run passes through from the relayed git.* command. */
interface GitReviewArgs {
  kind: 'git.status' | 'git.diff' | 'git.commit' | 'git.revert' | 'git.push' | 'git.pr' | 'git.merge';
  path?: string;
  message?: string;
  paths?: string[];
  title?: string;
  body?: string;
  base?: string;
  /** git.merge: GitHub's merge method (a merge commit when unset). */
  method?: 'merge' | 'squash' | 'rebase';
  /** git.merge: the branch whose pull request to merge; the worktree's HEAD when unset. */
  head?: string;
  /** Celiador agent task: the run's own worktree; the main checkout when unset. */
  root?: string;
}

/** The `fs.result` payload (minus requestId, which the run owns). */
interface GitReviewResult {
  ok: boolean;
  error?: string;
  branch?: string;
  files?: Array<{ path: string; status: string }>;
  patch?: string;
  sha?: string;
  remote?: string;
  url?: string;
  created?: boolean;
  /** git.merge: true once GitHub reports the pull request merged. */
  merged?: boolean;
  /** git.pr / finishTask: the pull request's size, as GitHub reports it. */
  pr?: PullRequestInfo;
}

/** The numbers a task reports for its pull request (agents UI contract §2). */
export interface PullRequestInfo {
  number: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** {@link PullRequestInfo} from a GitHub pull request object; undefined without a number. */
function pullRequestInfo(pr: any): PullRequestInfo | undefined {
  if (typeof pr?.number !== 'number') {return undefined;}
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return { number: pr.number, additions: num(pr.additions), deletions: num(pr.deletions), changedFiles: num(pr.changed_files) };
}

// Minimal slices of the vscode.git API (extensions/git/src/api/git.d.ts).
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: { name?: string; upstream?: { remote: string; name: string } } | undefined;
    remotes: GitRemote[];
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges: GitChange[];
  };
  status(): Promise<void>;
  diffWithHEAD(path: string): Promise<string>;
  add(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  getCommit(ref: string): Promise<{ hash: string }>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

/** The remote a branch should go to: its upstream if set, else origin, else the first one. */
function pickRemote(repo: GitRepository): GitRemote | undefined {
  const upstream = repo.state.HEAD?.upstream?.remote;
  const remotes = repo.state.remotes;
  return (upstream ? remotes.find((r) => r.name === upstream) : undefined) ?? remotes.find((r) => r.name === 'origin') ?? remotes[0];
}

/** `owner/repo` from a GitHub remote URL (https or ssh); undefined for other hosts. */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) {return undefined;}
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/**
 * The GitHub CLI's token, when `gh` is installed and signed in. Agent task runs
 * finish in the background, where prompting for the editor's GitHub sign-in is
 * not an option; most developers who push with git already have `gh auth login`
 * done, so that sign-in opens the pull request instead.
 */
async function githubCliToken(): Promise<string | undefined> {
  const { execFile } = await import('child_process');
  return new Promise<string | undefined>((resolve) =>
    execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined)));
}

/**
 * The GitHub token to act with: the editor's GitHub sign-in, else the gh CLI's.
 * Silent by default (background relay commands must not prompt); `interactive`
 * asks for the editor's GitHub sign-in when neither exists (a user gesture).
 */
export async function githubToken(interactive = false): Promise<string | undefined> {
  const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
  const token = session?.accessToken ?? await githubCliToken();
  if (token || !interactive) {return token;}
  const asked = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }).then((s) => s, () => undefined);
  return asked?.accessToken;
}

/** A minimal GitHub REST caller bound to `token`. */
export function githubApi(token: string): (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }> {
  return async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'celiador-remote',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
}

/**
 * Merge the open pull request for `head` — the phone's "Approve and merge".
 * Fails plainly without a GitHub sign-in: unlike opening a PR there is no
 * browser fallback that keeps the loop on the phone.
 */
async function mergePullRequest(target: { owner: string; repo: string }, head: string, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<GitReviewResult> {
  const token = await githubToken();
  if (!token) {return { ok: false, error: 'merging needs a GitHub sign-in in the editor, or `gh auth login` on this machine' };}
  const api = githubApi(token);
  const repoPath = `/repos/${target.owner}/${target.repo}`;
  const open = await api('GET', `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${head}`)}`);
  const pr = Array.isArray(open.json) ? open.json[0] : undefined;
  if (typeof pr?.number !== 'number') {return { ok: false, error: `no open pull request for ${head}` };}
  const merged = await api('PUT', `${repoPath}/pulls/${pr.number}/merge`, { merge_method: method });
  if (merged.status === 200 && merged.json?.merged === true) {
    return { ok: true, merged: true, sha: typeof merged.json.sha === 'string' ? merged.json.sha : undefined, url: pr.html_url };
  }
  const detail = merged.json?.message;
  return { ok: false, merged: false, url: pr.html_url, error: typeof detail === 'string' ? detail : `GitHub returned ${merged.status}` };
}

/**
 * Open (or find) the pull request for `head` with the editor's GitHub sign-in,
 * else the GitHub CLI's. Without either we don't prompt from a background relay
 * command — the phone gets a compare link to finish in the browser instead.
 * Either way a found PR comes back with its size (`pr`).
 */
async function openPullRequest(target: { owner: string; repo: string }, head: string, args: GitReviewArgs): Promise<GitReviewResult> {
  const title = args.title!.trim();
  const token = await githubToken();
  const compareUrl = `https://github.com/${target.owner}/${target.repo}/compare/${encodeURIComponent(head)}?expand=1&title=${encodeURIComponent(title)}`;
  if (!token) {return { ok: true, url: compareUrl, created: false };}
  const api = githubApi(token);

  const repoPath = `/repos/${target.owner}/${target.repo}`;
  let base = args.base?.trim();
  if (!base) {
    const info = await api('GET', repoPath);
    base = typeof info.json?.default_branch === 'string' ? info.json.default_branch : 'main';
  }
  const created = await api('POST', `${repoPath}/pulls`, { title, body: args.body ?? '', head, base });
  if (created.status === 201 && typeof created.json?.html_url === 'string') {
    return { ok: true, url: created.json.html_url, created: true, pr: pullRequestInfo(created.json) };
  }
  // Already open for this branch (e.g. a follow-up pushed more)? Hand back the
  // existing one; the list omits the size, so read the PR itself for it.
  const existing = await api('GET', `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${head}`)}`);
  if (Array.isArray(existing.json) && typeof existing.json[0]?.html_url === 'string') {
    const listed = existing.json[0];
    const full = typeof listed.number === 'number' ? await api('GET', `${repoPath}/pulls/${listed.number}`).catch(() => undefined) : undefined;
    return { ok: true, url: listed.html_url, created: false, pr: pullRequestInfo(full?.status === 200 ? full.json : listed) };
  }
  const detail = created.json?.errors?.[0]?.message ?? created.json?.message;
  return { ok: false, error: typeof detail === 'string' ? detail : `GitHub returned ${created.status}` };
}
interface GitAPI {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

/** vscode.git `Status` enum → the short code the phone renders. */
const STATUS_CODE: Record<number, string> = {
  0: 'M', // INDEX_MODIFIED
  1: 'A', // INDEX_ADDED
  2: 'D', // INDEX_DELETED
  3: 'R', // INDEX_RENAMED
  4: 'C', // INDEX_COPIED
  5: 'M', // MODIFIED
  6: 'D', // DELETED
  7: 'U', // UNTRACKED
  9: 'A', // INTENT_TO_ADD
  10: 'R', // INTENT_TO_RENAME
  11: 'M', // TYPE_CHANGED
};
const IGNORED = 8;

async function getRepo(root?: string): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) {throw new Error('git is not available');}
  const api = (await ext.activate() as { getAPI(version: number): GitAPI }).getAPI(1);
  // An agent task runs in its own worktree: open that repository rather than the window's.
  const repo = root
    ? api.getRepository(vscode.Uri.file(root)) ?? await api.openRepository(vscode.Uri.file(root))
    : api.repositories[0];
  if (!repo) {throw new Error(root ? `no git repository at ${root}` : 'no git repository open');}
  return repo;
}

/** Workspace-relative path for a changed file (repo-root relative, / separators). */
function relPath(repo: GitRepository, uri: vscode.Uri): string {
  const root = repo.rootUri.path.replace(/\/+$/, '');
  return uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : uri.path;
}

/** Resolve a repo-relative path to an absolute fsPath, rejecting `..` escapes. */
function absPath(repo: GitRepository, rel: string): string {
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {throw new Error('bad path');}
  return vscode.Uri.joinPath(repo.rootUri, ...segments).fsPath;
}

/** All changed files (index + working tree + untracked), de-duped, ignored skipped. */
function changedFiles(repo: GitRepository): Array<{ path: string; status: string }> {
  const seen = new Map<string, string>();
  const groups = [repo.state.indexChanges, repo.state.workingTreeChanges, repo.state.untrackedChanges];
  for (const group of groups) {
    for (const change of group) {
      if (change.status === IGNORED) {continue;}
      const path = relPath(repo, change.uri);
      if (!seen.has(path)) {seen.set(path, STATUS_CODE[change.status] ?? 'M');}
    }
  }
  return [...seen.entries()].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A pseudo-patch for a file git can't diff yet (untracked): whole file as added. */
async function untrackedPatch(repo: GitRepository, rel: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(repo.rootUri, ...rel.split('/')));
  const text = new TextDecoder().decode(bytes);
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

async function execute(args: GitReviewArgs): Promise<GitReviewResult> {
  const repo = await getRepo(args.root);
  switch (args.kind) {
    case 'git.status': {
      await repo.status(); // refresh so the phone sees the current tree, not a cached one
      return { ok: true, branch: repo.state.HEAD?.name, files: changedFiles(repo) };
    }
    case 'git.diff': {
      if (!args.path) {
        // Whole-run diff: concatenate per-file patches (keeps untracked files included).
        await repo.status();
        const parts: string[] = [];
        for (const file of changedFiles(repo)) {
          parts.push(file.status === 'U' ? await untrackedPatch(repo, file.path) : await repo.diffWithHEAD(file.path));
        }
        return { ok: true, patch: parts.filter((p) => p.length > 0).join('\n') };
      }
      const abs = absPath(repo, args.path);
      try {
        const patch = await repo.diffWithHEAD(abs);
        if (patch.length > 0) {return { ok: true, patch };}
      } catch {
        /* fall through to the untracked pseudo-patch */
      }
      return { ok: true, patch: await untrackedPatch(repo, args.path) };
    }
    case 'git.commit': {
      if (!args.message) {return { ok: false, error: 'message is required' };}
      await repo.status();
      const targets = args.paths?.length ? args.paths : changedFiles(repo).map((f) => f.path);
      if (!targets.length) {return { ok: false, error: 'nothing to commit' };}
      await repo.add(targets.map((p) => absPath(repo, p)));
      await repo.commit(args.message);
      const sha = await repo.getCommit('HEAD').then((c) => c.hash, () => undefined);
      return { ok: true, sha };
    }
    case 'git.revert': {
      if (!args.paths?.length) {return { ok: false, error: 'paths are required' };}
      // clean() discards: checkout for tracked changes, delete for untracked files.
      await repo.clean(args.paths.map((p) => absPath(repo, p)));
      return { ok: true };
    }
    case 'git.push': {
      await repo.status();
      const branch = repo.state.HEAD?.name;
      if (!branch) {return { ok: false, error: 'detached HEAD — check out a branch first' };}
      const remote = pickRemote(repo);
      if (!remote) {return { ok: false, error: 'no git remote configured' };}
      await repo.push(remote.name, branch, true);
      return { ok: true, branch, remote: remote.name };
    }
    case 'git.pr': {
      if (!args.title?.trim()) {return { ok: false, error: 'title is required' };}
      await repo.status();
      const branch = repo.state.HEAD?.name;
      if (!branch) {return { ok: false, error: 'detached HEAD — check out a branch first' };}
      const remote = pickRemote(repo);
      const target = parseGitHubRemote(remote?.pushUrl ?? remote?.fetchUrl);
      if (!target) {return { ok: false, error: `the branch's remote is not on GitHub` };}
      return openPullRequest(target, branch, args);
    }
    case 'git.merge': {
      await repo.status();
      // A finished task names its branch (contract §4): the worktree may have moved on.
      const branch = args.head?.trim() || repo.state.HEAD?.name;
      if (!branch) {return { ok: false, error: 'detached HEAD — check out a branch first' };}
      const remote = pickRemote(repo);
      const target = parseGitHubRemote(remote?.pushUrl ?? remote?.fetchUrl);
      if (!target) {return { ok: false, error: `the branch's remote is not on GitHub` };}
      return mergePullRequest(target, branch, args.method);
    }
  }
}

/** Register the command an agent run delegates the phone's git.* commands to. */
export function registerGitReview(): vscode.Disposable {
  return vscode.commands.registerCommand('celiadorRemote.relayGit', async (args: GitReviewArgs): Promise<GitReviewResult> => {
    try {
      return await execute(args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// --- Agent tasks (issue → worktree run → pull request) -----------------------

/** What the control stream asks for when a task's run has finished. */
interface FinishTaskArgs {
  /** The run's worktree. */
  root: string;
  title: string;
  issue?: { number: number; url: string };
  /** Add the opt-in "made with Celiador" line to the pull request body. */
  attribution?: boolean;
  /** The run's final assistant message: the pull request body is written from it (stand-out contract §4). */
  finalMessage?: string;
  /** When the run started (epoch ms), for the body's elapsed time. */
  startedAt?: number;
  /** This computer's name, for the body's "Run by Celiador on …" line. */
  machine?: string;
}

/** Run `git -C <cwd> <args>` and resolve its stdout (rejects on a non-zero exit). */
export async function runGit(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}

/** The repository's default branch as origin advertises it (`origin/HEAD`), if known. */
export async function defaultBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const ref = (await runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    return ref.replace(/^origin\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * This computer's name for "Running on <machine>": the macOS Computer Name
 * ("Stefan's MacBook Pro") when available, else the host name minus `.local`.
 */
export async function machineName(): Promise<string> {
  const os = await import('os');
  if (process.platform === 'darwin') {
    const { execFile } = await import('child_process');
    const pretty = await new Promise<string | undefined>((resolve) =>
      execFile('scutil', ['--get', 'ComputerName'], { timeout: 5_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined)));
    if (pretty) {return pretty;}
  }
  return os.hostname().replace(/\.local$/i, '');
}

/** How many files the branch changes against origin's default branch; undefined when git can't tell. */
async function changedFileCount(root: string): Promise<number | undefined> {
  const base = await defaultBranch(root);
  if (!base) {return undefined;}
  try {
    const out = await runGit(root, ['diff', '--name-only', `origin/${base}...HEAD`]);
    return out.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

/** The worktree checked out on `branch` under the repository at `repoRoot`, if any. */
async function worktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  let current: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branch}`) {
      return current;
    }
  }
  return undefined;
}

/**
 * Finish an agent task: commit whatever the agent left uncommitted, push the
 * branch, and open its pull request, whose body ({@link composeTaskPrBody})
 * tells the reviewer what the agent did and what it is unsure about (`Closes
 * #n` when it came from an issue). Uses the user's git identity, hooks and
 * credentials, and the editor's GitHub sign-in — without one, a compare link
 * comes back instead (`created: false`).
 */
async function finishTask(args: FinishTaskArgs): Promise<GitReviewResult> {
  const repo = await getRepo(args.root);
  await repo.status();
  const branch = repo.state.HEAD?.name;
  if (!branch) {return { ok: false, error: 'the run left a detached HEAD' };}
  const leftovers = changedFiles(repo);
  if (leftovers.length) {
    await repo.add(leftovers.map((f) => absPath(repo, f.path)));
    await repo.commit(args.issue ? `${args.title} (#${args.issue.number})` : args.title);
  }
  const remote = pickRemote(repo);
  const target = parseGitHubRemote(remote?.pushUrl ?? remote?.fetchUrl);
  if (!remote || !target) {return { ok: false, error: `the repository's remote is not on GitHub` };}
  // The task branch is the agent's own. A follow-up turn may have amended or
  // rebased what it already pushed, so push with a lease: it rewrites only if the
  // remote still holds what this worktree last fetched (nobody else pushed).
  // Plain git, since the git extension refuses forced pushes unless git.allowForcePush.
  try {
    await runGit(repo.rootUri.fsPath, ['push', '--force-with-lease', '--set-upstream', remote.name, `${branch}:${branch}`], 120_000);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n').filter((l) => l.trim()).slice(-2).join(' ') : String(err);
    return { ok: false, error: `couldn't push ${branch}: ${detail}` };
  }
  // The body is built here from the final message (the daemon, which also gets
  // it as `summary`, refreshes the body with the cost once it can).
  const body = composeTaskPrBody({
    issueNumber: args.issue?.number,
    finalMessage: args.finalMessage,
    machine: args.machine ?? await machineName().catch(() => undefined),
    files: await changedFileCount(repo.rootUri.fsPath),
    elapsedMs: typeof args.startedAt === 'number' ? Math.max(0, Date.now() - args.startedAt) : undefined,
    attribution: args.attribution,
  });
  const pr = await openPullRequest(target, branch, { kind: 'git.pr', title: args.title, body });
  if (!pr.ok && /no commits between/i.test(pr.error ?? '')) {
    return { ok: false, error: 'the agent made no changes' };
  }
  return { ...pr, branch };
}

/** Register the agent-task commands the control stream (control.ts) calls. */
export function registerTaskCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('celiadorRemote.taskWorktree', async (args: { repoRoot: string; branch: string }): Promise<string | undefined> => {
      try {
        return await worktreeForBranch(args.repoRoot, args.branch);
      } catch {
        return undefined;
      }
    }),
    // What the control stream reports alongside a task: this computer's name and
    // the repository's default branch (the "picked up" comment's PR base).
    vscode.commands.registerCommand('celiadorRemote.taskContext', async (args?: { repoRoot?: string }): Promise<{ machine?: string; defaultBranch?: string }> => {
      const [machine, base] = await Promise.all([
        machineName().catch(() => undefined),
        args?.repoRoot ? defaultBranch(args.repoRoot) : Promise.resolve(undefined),
      ]);
      return { machine, defaultBranch: base };
    }),
    vscode.commands.registerCommand('celiadorRemote.finishTask', async (args: FinishTaskArgs): Promise<GitReviewResult> => {
      try {
        return await finishTask(args);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
    // The "picked up" comment on a queued issue, with the editor's GitHub
    // sign-in or the gh CLI's. Best-effort: without either it reports why.
    vscode.commands.registerCommand('celiadorRemote.commentOnIssue', async (args: { remoteUrl: string; number: number; body: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        const target = parseGitHubRemote(args.remoteUrl);
        if (!target) {return { ok: false, error: 'the repository is not on GitHub' };}
        const token = await githubToken();
        if (!token) {return { ok: false, error: 'no GitHub sign-in' };}
        const res = await githubApi(token)('POST', `/repos/${target.owner}/${target.repo}/issues/${args.number}/comments`, { body: args.body });
        return res.status === 201 ? { ok: true } : { ok: false, error: typeof res.json?.message === 'string' ? res.json.message : `GitHub returned ${res.status}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
