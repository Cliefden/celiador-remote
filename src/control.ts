/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { openRepos } from './presence';
import { AgentRun, type RunDeps } from './runner';
import { signal } from './telemetry';
import { createWorktree } from './worktree';

// The daemon's per-user control stream: the phone's "run on your editor"
// requests and the agent task queue's "start-task" commands arrive here. A
// command whose repository this window does not have open is ignored (another
// window, or none, has it).

const RECONNECT_MS = 3_000;
const FINISHED_RUN_TTL_MS = 24 * 60 * 60_000;

interface RunCommand {
  readonly kind: 'start-run';
  readonly requestId: string;
  readonly remoteUrl: string;
  readonly name?: string;
  readonly branch?: string;
  readonly prompt: string;
}

interface TaskCommand {
  readonly kind: 'start-task';
  readonly taskId: string;
  readonly remoteUrl: string;
  readonly name?: string;
  readonly branch: string;
  readonly prompt: string;
  readonly title: string;
  readonly issue?: { readonly number: number; readonly url: string };
  readonly commented?: boolean;
}

interface FinishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export class Control implements vscode.Disposable {
  private readonly abort = new AbortController();
  private readonly handled = new Set<string>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly runsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRuns = this.runsEmitter.event;
  private disposed = false;

  constructor(
    private readonly deps: RunDeps,
    private readonly output: vscode.OutputChannel,
    private readonly getToken: () => Promise<string | undefined>,
  ) {
    void this.loop();
  }

  get activeRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  /** Start a run on a workspace folder from the editor itself (the command palette). */
  startLocalRun(root: string, title: string, prompt: string): AgentRun {
    return this.launch(root, { title, prompt, permissionMode: this.permissionMode() });
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

  private launch(root: string, options: { title: string; prompt: string; permissionMode: PermissionMode; taskId?: string }): AgentRun {
    const run = new AgentRun({ root, ...options }, this.deps, this.output);
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
    let cmd: RunCommand | TaskCommand;
    try {cmd = JSON.parse(payload);} catch {return;}
    if (cmd.kind === 'start-task') {return this.startTask(cmd);}
    if (cmd.kind !== 'start-run' || !cmd.requestId || !cmd.remoteUrl || this.handled.has(cmd.requestId)) {return;}
    const repo = this.repoFor(cmd.remoteUrl);
    if (!repo) {return;}
    this.handled.add(cmd.requestId);
    // The phone may open a run without a first message (the editor fork opens an
    // idle chat); here the person at the keyboard types it.
    const seeded = !!cmd.prompt?.trim();
    const prompt = cmd.prompt?.trim() || (await vscode.window.showInputBox({ title: `Your phone wants to run an agent on ${cmd.name ?? repo.fsPath}`, prompt: 'What should it do?', ignoreFocusOut: true }))?.trim();
    if (!prompt) {return;}
    this.launch(repo.fsPath, { title: prompt.slice(0, 80), prompt, permissionMode: this.permissionMode() });
    const nested = !vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === repo.fsPath);
    signal({ type: 'celiador/phoneRun', payload: { seeded: seeded ? 'true' : 'false', nested: nested ? 'true' : 'false' } });
    void vscode.window.showInformationMessage(`Celiador: an agent is running on ${cmd.name ?? repo.fsPath}, started from your phone.`);
  }

  /** A queued task: new worktree on its branch, run, then push and open the pull request. */
  private async startTask(cmd: TaskCommand): Promise<void> {
    if (!cmd.taskId || !cmd.remoteUrl || !cmd.branch || !cmd.prompt || this.handled.has(cmd.taskId)) {return;}
    const repo = this.repoFor(cmd.remoteUrl);
    if (!repo) {return;}
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
    const run = this.launch(worktree.path, { title: cmd.title || cmd.branch, prompt: cmd.prompt, permissionMode: this.permissionMode(), taskId: cmd.taskId });
    await this.reportTask(cmd.taskId, { state: 'running', sessionId: run.sessionId });
    if (cmd.issue && !cmd.commented && settings.get<boolean>('agentTasks.issueComment') !== false) {
      const body = `Celiador picked this up: an agent is working on it in a worktree on branch \`${worktree.branch}\` and will open a pull request linked here. Approvals and questions go to the Celiador queue.`;
      void vscode.commands.executeCommand<{ ok: boolean; error?: string }>('celiadorRemote.commentOnIssue', { remoteUrl: cmd.remoteUrl, number: cmd.issue.number, body })
        .then((r) => { if (!r?.ok) {this.deps.log(`task ${cmd.taskId}: no issue comment (${r?.error ?? 'unavailable'})`);} }, () => undefined);
    }
    const status = await run.start();
    if (status !== 'done') {
      signal({ type: 'celiador/taskRun', payload: { result: status === 'cancelled' ? 'cancelled' : 'failed' } });
      await this.reportTask(cmd.taskId, { state: 'failed', error: status === 'cancelled' ? 'The run was cancelled.' : 'The agent run failed.' });
      return;
    }
    try {
      const result = await vscode.commands.executeCommand<FinishResult>('celiadorRemote.finishTask', {
        root: worktree.path,
        title: cmd.title || cmd.branch,
        issue: cmd.issue,
        attribution: settings.get<boolean>('agentTasks.attribution') === true,
      });
      if (!result?.ok || !result.url) {throw new Error(result?.error ?? 'opening the pull request failed');}
      await this.reportTask(cmd.taskId, { state: 'pr-open', prUrl: result.url });
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

  private async reportTask(taskId: string, status: { state: 'running' | 'pr-open' | 'failed'; sessionId?: string; prUrl?: string; error?: string }): Promise<void> {
    const token = await this.getToken().catch(() => undefined);
    if (!token) {return;}
    try {
      await fetch(`${this.deps.daemonUrl()}/api/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(status),
      });
    } catch (err) {
      this.deps.log(`task status report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private repoFor(remoteUrl: string): vscode.Uri | undefined {
    return openRepos().find((r) => r.remoteUrl.toLowerCase() === remoteUrl.toLowerCase())?.folder;
  }

  private backoff(): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, RECONNECT_MS);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
