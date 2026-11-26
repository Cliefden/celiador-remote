/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { EditorCommand, EditorTaskRequest, TaskStatusReport } from './contract';
import { openRepos } from './presence';
import { AgentRun, type RunDeps } from './runner';
import { signal } from './telemetry';
import type { RunTrust } from './trust';
import { createWorktree } from './worktree';

// The daemon's per-user control stream: the phone's "run on your editor"
// requests and the agent task queue's "start-task" commands arrive here. A
// command whose repository this window does not have open is ignored (another
// window, or none, has it).

const RECONNECT_MS = 3_000;
const FINISHED_RUN_TTL_MS = 24 * 60 * 60_000;

/** The pull request's size, as GitHub reports it (gitReview.ts `PullRequestInfo`). */
type TaskPullRequest = NonNullable<TaskStatusReport['pr']>;

interface FinishResult {
  ok: boolean;
  url?: string;
  error?: string;
  pr?: TaskPullRequest;
}

/** The final message sent as `summary` is clipped to this, as in the editor. */
const TASK_SUMMARY_MAX_CHARS = 8000;

/** The "picked up" comment on a queued issue (same text as the Celiador editor's). */
function pickedUpComment(options: { machine?: string; branch: string; baseBranch?: string; taskId: string; openBaseUrl: string }): string {
  const base = options.openBaseUrl.replace(/\/+$/, '');
  return [
    `**Picked up.** Running on ${options.machine?.trim() || 'a computer'} in its own worktree, \`${options.branch}\`.`,
    '',
    `I'll open a pull request against \`${options.baseBranch?.trim() || 'main'}\` and link it here. Approvals and questions go to the Celiador queue.`,
    '',
    `[Watch the run](${base}/api/open/task/${encodeURIComponent(options.taskId)}) · [Open the queue](${base}/api/open/queue)`,
  ].join('\n');
}

export class Control implements vscode.Disposable {
  private readonly abort = new AbortController();
  private readonly handled = new Set<string>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly runsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRuns = this.runsEmitter.event;
  private disposed = false;
  private machine: string | undefined;

  constructor(
    private readonly deps: RunDeps,
    private readonly output: vscode.OutputChannel,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly trust: RunTrust,
  ) {
    void this.loop();
  }

  get activeRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  /** Start a run on a workspace folder from the editor itself (the command palette). Callers check trust first. */
  startLocalRun(root: string, title: string, prompt: string): AgentRun {
    return this.launch(root, root, { title, prompt, permissionMode: this.permissionMode() });
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const run of this.runs.values()) {run.dispose();}
    this.runs.clear();
    this.runsEmitter.dispose();
  }

  private permissionMode(): PermissionMode {
    return vscode.workspace.getConfiguration('celiador').get<string>('agentTasks.permissionMode') === 'default' ? 'default' : 'auto';
  }

  /** `repo` is the repository the run belongs to; `root` is where it works (the repository or a task's worktree). */
  private launch(repo: string, root: string, options: { title: string; prompt: string; permissionMode: PermissionMode; taskId?: string }): AgentRun {
    const repoSettings = this.trust.repoSettingsFor(repo);
    const run = new AgentRun({ root, ...options, repoSettings }, this.deps, this.output);
    if (repoSettings === 'skip') {
      this.deps.log(`run on ${root}: the repository's own .claude settings are not loaded (workspace trusted after the window opened)`);
      void this.trust.notifySkipped(repo, root);
    }
    this.runs.set(run.id, run);
    this.runsEmitter.fire();
    run.onDidChangeStatus(() => this.runsEmitter.fire());
    this.output.appendLine(`\n=== ${options.title} (${root}) ===`);
    void run.start().finally(() => {
      // A finished run stays reachable from the phone (diff, pull request,
      // merge go over its relay session) for a day, then is let go.
      setTimeout(() => { this.runs.delete(run.id); run.dispose(); this.runsEmitter.fire(); }, FINISHED_RUN_TTL_MS);
    });
    return run;
  }

  private async loop(): Promise<void> {
    while (!this.disposed) {
      const token = await this.getToken().catch(() => undefined);
      if (!token) {await this.backoff(); continue;}
      try {
        const res = await fetch(`${this.deps.daemonUrl()}/api/presence/commands`, { headers: { Authorization: `Bearer ${token}` }, signal: this.abort.signal });
        if (!res.ok || !res.body) {await this.backoff(); continue;}
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {break;}
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) {continue;}
            const payload = line.slice(5).trim();
            if (payload) {void this.handle(payload);}
          }
        }
      } catch (err) {
        if (this.disposed) {return;}
        this.deps.log(`control stream: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.backoff();
    }
  }

  private async handle(payload: string): Promise<void> {
    // Parsed from the wire: checked field by field below, never trusted.
    let cmd: EditorCommand;
    try {cmd = JSON.parse(payload);} catch {return;}
    if (cmd.kind === 'start-task') {return this.startTask(cmd);}
    if (cmd.kind !== 'start-run' || !cmd.requestId || !cmd.remoteUrl || this.handled.has(cmd.requestId)) {return;}
    const repo = this.repoFor(cmd.remoteUrl);
    if (!repo) {return;}
    this.handled.add(cmd.requestId);
    if (!this.trust.isTrusted) {
      this.deps.log(`phone run on ${repo.fsPath} refused: the workspace is not trusted`);
      void this.trust.explainRestricted(`your phone asked to run an agent on ${cmd.name ?? repo.fsPath}; it did not start.`);
      return;
    }
    // The phone may open a run without a first message (the editor fork opens an
    // idle chat); here the person at the keyboard types it.
    const seeded = !!cmd.prompt?.trim();
    const prompt = cmd.prompt?.trim() || (await vscode.window.showInputBox({ title: `Your phone wants to run an agent on ${cmd.name ?? repo.fsPath}`, prompt: 'What should it do?', ignoreFocusOut: true }))?.trim();
    if (!prompt) {return;}
    this.launch(repo.fsPath, repo.fsPath, { title: prompt.slice(0, 80), prompt, permissionMode: this.permissionMode() });
    const nested = !vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === repo.fsPath);
    signal({ type: 'celiador/phoneRun', payload: { seeded: seeded ? 'true' : 'false', nested: nested ? 'true' : 'false' } });
    void vscode.window.showInformationMessage(`Celiador: an agent is running on ${cmd.name ?? repo.fsPath}, started from your phone.`);
  }

  /** A queued task: new worktree on its branch, run, then push and open the pull request. */
  private async startTask(cmd: EditorTaskRequest): Promise<void> {
    if (!cmd.taskId || !cmd.remoteUrl || !cmd.branch || !cmd.prompt || this.handled.has(cmd.taskId)) {return;}
    const repo = this.repoFor(cmd.remoteUrl);
    if (!repo) {return;}
    if (!this.trust.isTrusted) {
      // Not taken: a trusted window (or this one, once trusted) can pick it up.
      this.deps.log(`task ${cmd.taskId}: not picked up, the workspace is not trusted`);
      return;
    }
    this.handled.add(cmd.taskId);
    const settings = vscode.workspace.getConfiguration('celiador');
    let worktree: { path: string; branch: string };
    try {
      worktree = await createWorktree(repo.fsPath, cmd.branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log(`task ${cmd.taskId}: worktree failed: ${message}`);
      await this.reportTask(cmd.taskId, { state: 'failed', error: `Couldn't create the worktree: ${message}` });
      return;
    }
    const run = this.launch(repo.fsPath, worktree.path, { title: cmd.title || cmd.branch, prompt: cmd.prompt, permissionMode: this.permissionMode(), taskId: cmd.taskId });
    await this.reportTask(cmd.taskId, { state: 'running', sessionId: run.sessionId });
    if (cmd.issue && !cmd.commented && settings.get<boolean>('agentTasks.issueComment') !== false) {
      const context = await this.taskContext(repo.fsPath);
      const body = pickedUpComment({ machine: context.machine, branch: worktree.branch, baseBranch: context.defaultBranch, taskId: cmd.taskId, openBaseUrl: this.deps.daemonUrl() });
      void vscode.commands.executeCommand<{ ok: boolean; error?: string }>('celiadorRemote.commentOnIssue', { remoteUrl: cmd.remoteUrl, number: cmd.issue.number, body })
        .then((r) => { if (!r?.ok) {this.deps.log(`task ${cmd.taskId}: no issue comment (${r?.error ?? 'unavailable'})`);} }, () => undefined);
    }
    const status = await run.start();
    if (status !== 'done') {
      signal({ type: 'celiador/taskRun', payload: { result: status === 'cancelled' ? 'cancelled' : 'failed' } });
      await this.reportTask(cmd.taskId, { state: 'failed', error: status === 'cancelled' ? 'The run was cancelled.' : 'The agent run failed.' });
      return;
    }
    // The run's final message: the pull request body is written from it, and the
    // daemon gets it as `summary` (it refreshes the body with the cost).
    const summary = run.lastText.trim() ? run.lastText.trim().slice(0, TASK_SUMMARY_MAX_CHARS) : undefined;
    try {
      const result = await vscode.commands.executeCommand<FinishResult>('celiadorRemote.finishTask', {
        root: worktree.path,
        title: cmd.title || cmd.branch,
        issue: cmd.issue,
        attribution: settings.get<boolean>('agentTasks.attribution') === true,
        finalMessage: summary,
        startedAt: run.startedAt.getTime(),
        machine: await this.machineName(),
      });
      if (!result?.ok || !result.url) {throw new Error(result?.error ?? 'opening the pull request failed');}
      await this.reportTask(cmd.taskId, { state: 'pr-open', prUrl: result.url, pr: result.pr, summary });
      signal({ type: 'celiador/taskRun', payload: { result: 'pr-open' } });
      this.deps.log(`task ${cmd.taskId} opened ${result.url}`);
      void vscode.window.showInformationMessage(`Celiador opened a pull request for “${cmd.title}”.`, 'Open').then((choice) => {
        if (choice) {void vscode.env.openExternal(vscode.Uri.parse(result.url!));}
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log(`task ${cmd.taskId} could not open its pull request: ${message}`);
      signal({ type: 'celiador/taskRun', payload: { result: 'failed' } });
      await this.reportTask(cmd.taskId, { state: 'failed', error: message });
    }
  }

  /** This computer's name and the repository's default branch, from the git review commands. */
  private async taskContext(repoRoot?: string): Promise<{ machine?: string; defaultBranch?: string }> {
    try {
      return await vscode.commands.executeCommand<{ machine?: string; defaultBranch?: string }>('celiadorRemote.taskContext', { repoRoot }) ?? {};
    } catch {
      return {};
    }
  }

  private async machineName(): Promise<string | undefined> {
    this.machine ??= (await this.taskContext()).machine;
    return this.machine;
  }

  /** Tell the daemon how a task is doing (with this computer's name); best-effort. */
  private async reportTask(taskId: string, status: TaskStatusReport): Promise<void> {
    const token = await this.getToken().catch(() => undefined);
    if (!token) {return;}
    const machine = await this.machineName();
    try {
      await fetch(`${this.deps.daemonUrl()}/api/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...status, ...(machine ? { machine } : {}) }),
      });
    } catch (err) {
      this.deps.log(`task status report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private repoFor(remoteUrl: string): vscode.Uri | undefined {
    // Every open repository, trusted or not, so a refused command is explained (see handle()).
    return openRepos().find((r) => r.remoteUrl.toLowerCase() === remoteUrl.toLowerCase())?.folder;
  }

  private backoff(): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, RECONNECT_MS);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
