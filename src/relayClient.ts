import { randomUUID } from 'crypto';

// The runner side of the Celiador agent-session relay, ported from the editor
// fork (src/vs/workbench/.../celiadorRelayClient.ts) with no workbench
// dependencies. A run publishes an ordered event log to the daemon; the phone
// watches it over SSE and sends commands back over the command channel.

export type RelayState = 'idle' | 'running' | 'awaiting' | 'done' | 'error' | 'cancelled';

export type RelayEvent =
  | { kind: 'activity'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: unknown }
  | { kind: 'toolResult'; callId: string; ok: boolean }
  | { kind: 'approval'; requestId: string; approvalKind: string; title?: string; path?: string; preview?: string }
  | { kind: 'question'; requestId: string; prompt: string; choices?: string[] }
  | { kind: 'diff'; path: string; patch: string }
  | { kind: 'state'; state: RelayState }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'fs.result'; requestId: string; ok: boolean; [key: string]: unknown };

export type RelayFsKind = 'fs.list' | 'fs.read' | 'fs.write';
export type RelayGitKind = 'git.status' | 'git.diff' | 'git.commit' | 'git.revert' | 'git.push' | 'git.pr' | 'git.merge';

export interface RelayGitArgs {
  readonly path?: string;
  readonly message?: string;
  readonly paths?: string[];
  readonly title?: string;
  readonly body?: string;
  readonly base?: string;
  readonly method?: 'merge' | 'squash' | 'rebase';
}

interface RelayCommand {
  readonly kind: string;
  readonly text?: string;
  readonly requestId?: string;
  readonly path?: string;
  readonly content?: string;
  readonly message?: string;
  readonly paths?: string[];
  readonly title?: string;
  readonly body?: string;
  readonly base?: string;
  readonly method?: 'merge' | 'squash' | 'rebase';
}

const FLUSH_MS = 150;
const RECONNECT_MS = 1500;
const URGENT = new Set(['approval', 'question', 'state', 'done', 'error', 'fs.result']);
const MAX_ATTEMPTS = 3;
const MAX_PRESTART_BUFFER = 500;

export interface RelayClientOptions {
  readonly getUrl: () => string;
  readonly getToken: () => Promise<string | undefined>;
  readonly log?: (message: string) => void;
  readonly onInstruct?: (text: string) => void;
  readonly onAnswer?: (requestId: string, text: string) => void;
  readonly onCancel?: () => void;
  readonly onApprovalDecision?: (requestId: string, approved: boolean) => void;
  readonly onFsCommand?: (kind: RelayFsKind, requestId: string, path: string, content: string | undefined) => void;
  readonly onGitCommand?: (kind: RelayGitKind, requestId: string, args: RelayGitArgs) => void;
}

export class RelayClient {
  private sessionId_: string | undefined;
  private lastState: string | undefined;
  private buffer: RelayEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private commandAbort: AbortController | undefined;
  private disposed = false;

  constructor(private readonly options: RelayClientOptions) {}

  get active(): boolean {
    return !!this.sessionId_;
  }

  get sessionId(): string | undefined {
    return this.sessionId_;
  }

  /** Create the session (titled by the first prompt) and open its command channel. */
  async start(title: string, taskId?: string): Promise<void> {
    if (this.sessionId_ || this.disposed) {return;}
    const token = await this.options.getToken();
    if (!token) {return;}
    try {
      const res = await fetch(`${this.options.getUrl()}/api/sessions`, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ title, origin: 'editor', runner: 'editor', ...(taskId ? { taskId } : {}) }),
      });
      if (!res.ok) {return;}
      const data = (await res.json()) as { session?: { id?: string } };
      this.sessionId_ = data.session?.id;
      if (this.sessionId_) {
        this.openCommands(this.sessionId_);
        void this.flush();
      }
    } catch {
      /* best-effort */
    }
  }

  publish(event: RelayEvent): void {
    if (this.disposed) {return;}
    if (event.kind === 'state') {
      if (event.state === this.lastState) {return;}
      this.lastState = event.state;
    }
    this.buffer.push(event);
    if (this.buffer.length > MAX_PRESTART_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_PRESTART_BUFFER);
    }
    if (!this.sessionId_) {return;}
    if (URGENT.has(event.kind)) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
    }
  }

  newRequestId(): string {
    return randomUUID();
  }

  dispose(): void {
    this.options.log?.(`relay ${this.sessionId_ ?? '-'} disposed\n${new Error().stack?.split('\n').slice(2, 6).join('\n')}`);
    void this.flush();
    this.disposed = true;
    this.commandAbort?.abort();
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  private flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const sessionId = this.sessionId_;
    if (!sessionId || this.buffer.length === 0) {return this.flushChain;}
    const batch = this.buffer;
    this.buffer = [];
    this.flushChain = this.flushChain.then(() => this.deliver(sessionId, batch));
    return this.flushChain;
  }

  private async deliver(sessionId: string, batch: RelayEvent[]): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.options.getToken().catch(() => undefined);
      if (!token) {return;}
      try {
        const res = await fetch(`${this.options.getUrl()}/api/sessions/${sessionId}/events`, {
          method: 'POST',
          headers: this.headers(token),
          body: JSON.stringify(batch),
        });
        if (res.ok) {return;}
        if (res.status !== 401 && res.status !== 429 && res.status < 500) {
          this.options.log?.(`relay dropped ${batch.length} event(s): HTTP ${res.status}`);
          return;
        }
      } catch {
        /* network — retry */
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    this.options.log?.(`relay dropped ${batch.length} event(s) after ${MAX_ATTEMPTS} attempts`);
  }

  private openCommands(id: string): void {
    this.commandAbort?.abort();
    const ac = new AbortController();
    this.commandAbort = ac;
    void this.readCommands(id, ac);
  }

  private async readCommands(id: string, ac: AbortController): Promise<void> {
    while (!ac.signal.aborted && this.sessionId_ === id) {
      try {
        const token = await this.options.getToken();
        if (!token) {return;}
        const res = await fetch(`${this.options.getUrl()}/api/sessions/${id}/commands`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          this.options.log?.(`relay ${id} commands: HTTP ${res.status}`);
          await this.backoff(ac);
          continue;
        }
        this.options.log?.(`relay ${id} commands connected`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {this.options.log?.(`relay ${id} commands ended`); break;}
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) {continue;}
            const payload = line.slice(5).trim();
            if (!payload) {continue;}
            try {
              this.handleCommand(JSON.parse(payload) as RelayCommand);
            } catch {
              /* malformed frame */
            }
          }
        }
      } catch (err) {
        if (ac.signal.aborted) {return;}
        this.options.log?.(`relay ${id} commands error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.backoff(ac);
    }
  }

  private handleCommand(cmd: RelayCommand): void {
    const o = this.options;
    if (cmd.kind === 'instruct' && typeof cmd.text === 'string') {
      o.onInstruct?.(cmd.text);
    } else if (cmd.kind === 'answer' && typeof cmd.text === 'string') {
      if (cmd.requestId) {o.onAnswer?.(cmd.requestId, cmd.text);} else {o.onInstruct?.(cmd.text);}
    } else if (cmd.kind === 'cancel') {
      o.onCancel?.();
    } else if ((cmd.kind === 'approve' || cmd.kind === 'reject') && cmd.requestId) {
      o.onApprovalDecision?.(cmd.requestId, cmd.kind === 'approve');
    } else if ((cmd.kind === 'fs.list' || cmd.kind === 'fs.read' || cmd.kind === 'fs.write') && cmd.requestId) {
      o.onFsCommand?.(cmd.kind, cmd.requestId, cmd.path ?? '', cmd.content);
    } else if ((cmd.kind === 'git.status' || cmd.kind === 'git.diff' || cmd.kind === 'git.commit' || cmd.kind === 'git.revert' || cmd.kind === 'git.push' || cmd.kind === 'git.pr' || cmd.kind === 'git.merge') && cmd.requestId) {
      o.onGitCommand?.(cmd.kind, cmd.requestId, { path: cmd.path, message: cmd.message, paths: cmd.paths, title: cmd.title, body: cmd.body, base: cmd.base, method: cmd.method });
    }
  }

  private backoff(ac: AbortController): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, RECONNECT_MS);
      ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
