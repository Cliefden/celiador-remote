import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// One git worktree per agent task, beside the repository
// (<repo>.worktrees/<branch>), on a fresh branch from the default branch — the
// same layout the Celiador editor uses, so a run never touches your checkout.

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {reject(new Error(stderr.trim() || err.message));} else {resolve(stdout);}
    });
  });
}

/** `origin/<default branch>` after a fetch, falling back to `main`. */
async function baseRef(repoRoot: string): Promise<string> {
  await git(repoRoot, ['fetch', '--quiet', 'origin']).catch(() => undefined);
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  const name = head.trim();
  if (name) {return name;}
  for (const candidate of ['origin/main', 'origin/master']) {
    if (await git(repoRoot, ['rev-parse', '--verify', '--quiet', candidate]).then(() => true, () => false)) {return candidate;}
  }
  return 'HEAD';
}

/** A branch name git accepts, unique in the repository (suffixed when taken). */
async function freeBranch(repoRoot: string, wanted: string): Promise<string> {
  const safe = wanted.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '') || 'celiador';
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? safe : `${safe}-${i + 1}`;
    const taken = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    if (!taken) {return name;}
  }
  return `${safe}-${Date.now()}`;
}

/** Create the task's worktree; returns its path and the branch it is on. */
export async function createWorktree(repoRoot: string, branch: string): Promise<{ path: string; branch: string }> {
  const name = await freeBranch(repoRoot, branch);
  const dir = path.join(`${repoRoot}.worktrees`, name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const base = await baseRef(repoRoot);
  await git(repoRoot, ['worktree', 'add', '--no-track', '-b', name, dir, base]);
  return { path: dir, branch: name };
}

/** The worktree checked out on `branch`, if any. */
export async function worktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  const out = await git(repoRoot, ['worktree', 'list', '--porcelain']).catch(() => '');
  let current: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {current = line.slice('worktree '.length);} else if (line === `branch refs/heads/${branch}`) {return current;}
  }
  return undefined;
}
