/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CanUseTool, Options, PermissionMode, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// The SDK ships as ES modules only; the extension host loads this bundle with
// require(), so the SDK is pulled in with a dynamic import() at run time.
const loadSdk = () => import('@anthropic-ai/claude-agent-sdk');
import { RelayClient, type RelayFsKind, type RelayGitArgs, type RelayGitKind } from './relayClient';
import type { DaemonProxy } from './proxy';

// One agent run: a Claude Agent SDK session on a repository (or a task's
// worktree), mirrored to the daemon's session relay so the phone can watch,
// approve, answer, steer and review it. This is the extension's equivalent of
// the editor fork's agent host + relay bridge, in one place.

/** Largest file we send to the phone as text; larger is returned truncated. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_INPUT_PREVIEW = 400;

export interface RunOptions {
  /** Where the agent works: the repository root or the task's worktree. */
  readonly root: string;
  readonly title: string;
  readonly prompt: string;
  readonly permissionMode: PermissionMode;
  /** Links the relay session to a queued task on the phone. */
  readonly taskId?: string;
}

export interface RunDeps {
  readonly daemonUrl: () => string;
  readonly getToken: () => Promise<string | undefined>;
  readonly proxy: DaemonProxy;
  /** The Claude Code CLI to spawn; undefined lets the SDK find its own. */
  readonly claudeExecutable: () => Promise<string | undefined>;
  readonly log: (message: string) => void;
}

export type RunStatus = 'running' | 'awaiting' | 'done' | 'error' | 'cancelled';

/** An async queue the SDK consumes as its streaming prompt: follow-up messages go in here. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(text: string): void {
    if (this.closed) {return;}
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage);
    this.waiter?.();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      if (this.items.length) {yield this.items.shift()!; continue;}
      if (this.closed) {return;}
      await new Promise<void>((resolve) => { this.waiter = resolve; });
      this.waiter = undefined;
    }
  }
}

export class AgentRun implements vscode.Disposable {
  readonly id = `run-${Date.now().toString(36)}`;
  private readonly abort = new AbortController();
  private readonly prompts = new PromptQueue();
  private readonly relay: RelayClient;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly pendingAnswers = new Map<string, (text: string) => void>();
  private readonly toolNames = new Map<string, string>();
  private readonly statusEmitter = new vscode.EventEmitter<RunStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private status_: RunStatus = 'running';
  private finished: Promise<RunStatus> | undefined;
  readonly startedAt = new Date();
  /** The assistant's final text, for the PR body and the output channel. */
  lastText = '';

  constructor(readonly options: RunOptions, private readonly deps: RunDeps, private readonly output: vscode.OutputChannel) {
    this.relay = new RelayClient({
      getUrl: deps.daemonUrl,
      getToken: deps.getToken,
      log: deps.log,
      onInstruct: (text) => this.instruct(text),
      onAnswer: (requestId, text) => this.answer(requestId, text),
      onCancel: () => this.cancel(),
      onApprovalDecision: (requestId, approved) => this.decide(requestId, approved),
      onFsCommand: (kind, requestId, rel, content) => void this.handleFs(kind, requestId, rel, content),
      onGitCommand: (kind, requestId, args) => void this.handleGit(kind, requestId, args),
    });
  }

  get status(): RunStatus {
    return this.status_;
  }

  get sessionId(): string | undefined {
    return this.relay.sessionId;
  }

  /** Start the run; resolves with its final status. Safe to call once. */
  start(): Promise<RunStatus> {
    if (!this.finished) {this.finished = this.execute();}
    return this.finished;
  }

  /** A follow-up message, from the phone or the editor. */
  instruct(text: string): void {
    this.relay.publish({ kind: 'message', role: 'user', text });
    this.prompts.push(text);
  }

  answer(requestId: string, text: string): void {
    const resolve = this.pendingAnswers.get(requestId);
    if (resolve) {this.pendingAnswers.delete(requestId); resolve(text);} else {this.instruct(text);}
  }

  decide(requestId: string, approved: boolean): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {this.pendingApprovals.delete(requestId); resolve(approved);}
  }

  cancel(): void {
    if (this.status_ === 'running' || this.status_ === 'awaiting') {this.setStatus('cancelled');}
    this.abort.abort();
    this.prompts.close();
  }

  dispose(): void {
    this.cancel();
    this.relay.dispose();
    this.statusEmitter.dispose();
  }

  private setStatus(status: RunStatus): void {
    if (this.status_ === status) {return;}
    this.status_ = status;
    this.relay.publish({ kind: 'state', state: status });
    this.statusEmitter.fire(status);
  }

  private async execute(): Promise<RunStatus> {
    await this.relay.start(this.options.title, this.options.taskId);
    this.relay.publish({ kind: 'message', role: 'user', text: this.options.prompt });
    this.relay.publish({ kind: 'state', state: 'running' });
    this.prompts.push(this.options.prompt);
    const proxyUrl = await this.deps.proxy.start();
    const sessionToken = `${this.deps.proxy.nonce}.${this.id}`;
    // The daemon picks the model (and publishes it); telling the CLI the same
    // name keeps its context sizing and request shape right for that model.
    const model = await publishedModel(this.deps.daemonUrl()).catch(() => undefined);
    const claudeExecutable = await this.deps.claudeExecutable();
    if (this.abort.signal.aborted) {return this.status_;}
    const env: Record<string, string | undefined> = {
      ...process.env,
      // Credentials come from the Celiador account through the loopback proxy,
      // never from a personal key that happens to be in the environment.
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: proxyUrl,
      ELECTRON_RUN_AS_NODE: '1',
    };
    const sdkOptions: Options = {
      cwd: this.options.root,
      executable: process.execPath as 'node',
      env,
      abortController: this.abort,
      canUseTool: this.canUseTool,
      permissionMode: this.options.permissionMode,
      ...(model ? { model } : {}),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      disallowedTools: ['WebSearch'],
      settingSources: ['user', 'project', 'local'],
      settings: {
        env: {
          ANTHROPIC_BASE_URL: proxyUrl,
          ANTHROPIC_AUTH_TOKEN: sessionToken,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      stderr: (data) => this.deps.log(`[claude] ${data.trimEnd()}`),
    };
    try {
      const { query } = await loadSdk();
      const q = query({ prompt: this.prompts, options: sdkOptions });
      for await (const message of q) {
        this.onMessage(message);
        if (message.type === 'result') {break;}
      }
      if (this.status_ === 'running' || this.status_ === 'awaiting') {
        this.relay.publish({ kind: 'done' });
        this.setStatus('done');
      }
    } catch (err) {
      if (this.status_ !== 'cancelled') {
        const text = err instanceof Error ? err.message : String(err);
        this.deps.log(`run failed: ${text}`);
        this.relay.publish({ kind: 'error', message: text });
        this.setStatus('error');
      }
    } finally {
      // The relay stays open after the run: the phone reviews the diff, opens
      // the pull request and merges over the same session (see dispose()).
      this.prompts.close();
    }
    return this.status_;
  }

  private onMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'stream_event': {
        const event = message.event as { type: string; delta?: { type?: string; text?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          this.relay.publish({ kind: 'delta', text: event.delta.text });
          this.output.append(event.delta.text);
        }
        break;
      }
      case 'assistant': {
        const blocks = message.message.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
        if (text) {this.lastText = text;}
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id && block.name) {
            this.toolNames.set(block.id, block.name);
            this.relay.publish({ kind: 'tool', callId: block.id, name: block.name, input: summarizeInput(block.input) });
            this.relay.publish({ kind: 'activity', text: describeTool(block.name, block.input) });
            this.output.appendLine(`\n[${block.name}] ${describeTool(block.name, block.input)}`);
          }
        }
        if (message.error) {
          this.deps.log(`assistant error ${message.error}: ${JSON.stringify(message.message.content).slice(0, 500)}`);
          this.relay.publish({ kind: 'activity', text: `API error: ${message.error}` });
        }
        break;
      }
      case 'user': {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              this.relay.publish({ kind: 'toolResult', callId: block.tool_use_id, ok: !block.is_error });
              this.toolNames.delete(block.tool_use_id);
            }
          }
        }
        break;
      }
      case 'result': {
        this.output.appendLine('');
        if (message.subtype !== 'success' || message.is_error) {
          this.deps.log(`result ${JSON.stringify(message).slice(0, 800)}`);
          const detail = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : message.subtype;
          this.relay.publish({ kind: 'error', message: `The agent run ended: ${detail}` });
          this.setStatus('error');
        } else if ('result' in message && typeof message.result === 'string' && message.result) {
          this.lastText = message.result;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Claude asks whether a tool may run: the phone (and the editor) decide. */
  private readonly canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (toolName === 'AskUserQuestion') {
      return this.askQuestion(input, signal);
    }
    const requestId = this.relay.newRequestId();
    const title = describeTool(toolName, input);
    this.setStatus('awaiting');
    this.relay.publish({ kind: 'approval', requestId, approvalKind: toolName, title, path: pathOf(input), preview: previewOf(toolName, input) });
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
      signal.addEventListener('abort', () => resolve(false), { once: true });
      // The same question in the editor, so whoever is at the keyboard can answer too.
      void vscode.window.showWarningMessage(`Celiador agent wants to run ${toolName}: ${title}`, 'Approve', 'Deny').then((choice) => {
        if (choice) {this.decide(requestId, choice === 'Approve');}
      });
    });
    this.pendingApprovals.delete(requestId);
    if (this.status_ === 'awaiting') {this.setStatus('running');}
    return approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this tool call.' };
  };

  private async askQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<ReturnType<CanUseTool> extends Promise<infer R> ? R : never> {
    const questions = Array.isArray(input.questions) ? input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> : [];
    const first = questions[0];
    const prompt = first?.question ?? 'The agent needs your input.';
    const choices = first?.options?.map((o) => o.label).filter((l): l is string => typeof l === 'string');
    const requestId = this.relay.newRequestId();
    this.setStatus('awaiting');
    this.relay.publish({ kind: 'question', requestId, prompt, choices });
    const text = await new Promise<string | undefined>((resolve) => {
      this.pendingAnswers.set(requestId, resolve);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
      const local = choices?.length
        ? vscode.window.showQuickPick(choices, { title: 'Celiador agent asks', placeHolder: prompt })
        : vscode.window.showInputBox({ title: 'Celiador agent asks', prompt });
      void local.then((value) => { if (value !== undefined) {this.answer(requestId, value);} });
    });
    this.pendingAnswers.delete(requestId);
    if (this.status_ === 'awaiting') {this.setStatus('running');}
    if (text === undefined) {return { behavior: 'deny', message: 'No answer.' };}
    this.relay.publish({ kind: 'message', role: 'user', text });
    const answers: Record<string, string> = {};
    for (const q of questions) {if (q.question) {answers[q.question] = text;}}
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  // --- the phone's file explorer and review, served from the run's root -------

  private resolveInRoot(rel: string): string | undefined {
    const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.some((s) => s === '..')) {return undefined;}
    return path.join(this.options.root, ...segments);
  }

  private async handleFs(kind: RelayFsKind, requestId: string, rel: string, content: string | undefined): Promise<void> {
    try {
      const target = this.resolveInRoot(rel);
      if (!target) {throw new Error('bad path');}
      if (kind === 'fs.list') {
        const entries = (await fs.promises.readdir(target, { withFileTypes: true }))
          .filter((d) => d.name !== '.git')
          .map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isDirectory() ? undefined : safeSize(path.join(target, d.name)) }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        this.relay.publish({ kind: 'fs.result', requestId, ok: true, entries });
      } else if (kind === 'fs.read') {
        const bytes = await fs.promises.readFile(target);
        if (bytes.includes(0)) {this.relay.publish({ kind: 'fs.result', requestId, ok: false, error: 'binary file' }); return;}
        const truncated = bytes.length > MAX_FILE_BYTES;
        const slice = truncated ? bytes.subarray(0, MAX_FILE_BYTES) : bytes;
        this.relay.publish({ kind: 'fs.result', requestId, ok: true, content: slice.toString('utf8'), encoding: 'utf8', truncated });
      } else {
        await fs.promises.writeFile(target, content ?? '', 'utf8');
        this.relay.publish({ kind: 'fs.result', requestId, ok: true });
      }
    } catch (err) {
      this.relay.publish({ kind: 'fs.result', requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleGit(kind: RelayGitKind, requestId: string, args: RelayGitArgs): Promise<void> {
    try {
      const result = await vscode.commands.executeCommand<{ ok: boolean; [key: string]: unknown }>('celiador.relayGit', { kind, ...args, root: this.options.root });
      this.relay.publish({ ...(result ?? { ok: false, error: 'no result' }), kind: 'fs.result', requestId });
    } catch (err) {
      this.relay.publish({ kind: 'fs.result', requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

let modelCache: { url: string; model: string; at: number } | undefined;

/** The model the daemon runs agents on, from its public `/api/limits` (cached an hour). */
async function publishedModel(daemonUrl: string): Promise<string | undefined> {
  if (modelCache && modelCache.url === daemonUrl && Date.now() - modelCache.at < 3_600_000) {return modelCache.model;}
  const res = await fetch(`${daemonUrl}/api/limits`, { headers: { accept: 'application/json' } });
  if (!res.ok) {return undefined;}
  const data = (await res.json()) as { model?: unknown };
  if (typeof data.model !== 'string' || !data.model) {return undefined;}
  modelCache = { url: daemonUrl, model: data.model, at: Date.now() };
  return data.model;
}

function safeSize(file: string): number | undefined {
  try {return fs.statSync(file).size;} catch {return undefined;}
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === 'string' ? p : undefined;
}

function previewOf(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'Bash' && typeof input.command === 'string') {return input.command.slice(0, 2000);}
  if ((toolName === 'Write') && typeof input.content === 'string') {return input.content.slice(0, 2000);}
  if (toolName === 'Edit' && typeof input.new_string === 'string') {return input.new_string.slice(0, 2000);}
  return undefined;
}

/** One line the phone shows for a tool call. */
export function describeTool(toolName: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const p = pathOf(i);
  switch (toolName) {
    case 'Bash': return typeof i.description === 'string' && i.description ? i.description : String(i.command ?? '').slice(0, MAX_INPUT_PREVIEW);
    case 'Read': return `Read ${p ?? ''}`.trim();
    case 'Write': return `Write ${p ?? ''}`.trim();
    case 'Edit': case 'MultiEdit': return `Edit ${p ?? ''}`.trim();
    case 'Glob': return `Find files ${String(i.pattern ?? '')}`.trim();
    case 'Grep': return `Search for ${String(i.pattern ?? '')}`.trim();
    case 'WebFetch': return `Fetch ${String(i.url ?? '')}`.trim();
    case 'Task': case 'Agent': return typeof i.description === 'string' ? i.description : 'Run a subagent';
    default: return p ? `${toolName} ${p}` : toolName;
  }
}

function summarizeInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') {return {};}
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = typeof value === 'string' && value.length > MAX_INPUT_PREVIEW ? `${value.slice(0, MAX_INPUT_PREVIEW)}…` : value;
  }
  return out;
}
