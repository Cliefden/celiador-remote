import * as http from 'http';
import { randomBytes } from 'crypto';

// A loopback proxy in front of the daemon's Anthropic gateway. The Claude
// subprocess reads its credentials once at startup; the user's Celiador token
// expires hourly. So the subprocess gets a nonce, and this proxy attaches the
// *current* token to every forwarded request — a refresh lands mid-turn.
// Same design as the editor fork's CeliadorDaemonProxyService.

const DROPPED_HEADERS = new Set([
  'host', 'authorization', 'x-api-key', 'connection', 'content-length', 'content-encoding',
  'transfer-encoding', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect',
]);

export class DaemonProxy {
  private server: http.Server | undefined;
  private baseUrl_ = '';
  readonly nonce = randomBytes(32).toString('hex');
  private readonly inFlight = new Set<AbortController>();

  constructor(
    private readonly gatewayUrl: () => string,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly log: (message: string) => void,
  ) {}

  get baseUrl(): string {
    return this.baseUrl_;
  }

  async start(): Promise<string> {
    if (this.server) {return this.baseUrl_;}
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {throw new Error('proxy failed to bind');}
    this.server = server;
    this.baseUrl_ = `http://127.0.0.1:${address.port}`;
    this.log(`daemon proxy listening on ${this.baseUrl_}`);
    return this.baseUrl_;
  }

  dispose(): void {
    for (const ac of this.inFlight) {ac.abort();}
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
  }

  /** `Bearer <nonce>.<sessionId>` — the only credential the subprocess holds. */
  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {return false;}
    const token = header.slice('Bearer '.length);
    const dot = token.indexOf('.');
    return dot > 0 && token.slice(0, dot) === this.nonce && token.length > dot + 1;
  }

  private writeError(res: http.ServerResponse, status: number, type: string, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message }, request_id: null }));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (!this.authorized(req)) {
      this.log(`proxy refused ${method} ${url.pathname}: bad session token`);
      this.writeError(res, 401, 'authentication_error', 'Invalid authentication');
      return;
    }
    const token = await this.getToken().catch(() => undefined);
    if (!token) {
      this.writeError(res, 401, 'authentication_error', 'Signed out of Celiador');
      return;
    }
    const chunks: Buffer[] = [];
    if (method !== 'GET' && method !== 'HEAD') {
      for await (const chunk of req) {chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));}
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_HEADERS.has(name)) {continue;}
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('authorization', `Bearer ${token}`);
    const ac = new AbortController();
    this.inFlight.add(ac);
    const onClose = () => ac.abort();
    res.on('close', onClose);
    try {
      let upstream: Response;
      try {
        upstream = await fetch(`${this.gatewayUrl()}${url.pathname}${url.search}`, {
          method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
          signal: ac.signal,
        });
      } catch (err) {
        if (!res.headersSent) {this.writeError(res, 502, 'api_error', `Celiador daemon unreachable: ${err instanceof Error ? err.message : String(err)}`);}
        return;
      }
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => { if (!DROPPED_HEADERS.has(name)) {out[name] = value;} });
      if (upstream.status >= 400) {
        const body = await upstream.clone().text().catch(() => '');
        this.log(`proxy ${method} ${url.pathname}${url.search} → ${upstream.status} ${body.slice(0, 300)}`);
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body) {res.end(); return;}
      const trace = process.env.CELIADOR_PROXY_TRACE === '1';
      if (trace) {this.log(`proxy ${method} ${url.pathname}${url.search} beta=${req.headers['anthropic-beta'] ?? '-'} body=${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`);}
      let seen = 0;
      for await (const chunk of upstream.body) {
        if (ac.signal.aborted) {break;}
        if (trace && seen < 2000) {seen += chunk.length; this.log(`proxy ← ${upstream.status} ${upstream.headers.get('content-type')}: ${Buffer.from(chunk).toString('utf8').slice(0, 600).replace(/\n/g, '⏎')}`);}
        res.write(chunk);
      }
      if (!ac.signal.aborted) {res.end();}
    } catch (err) {
      if (!res.headersSent) {this.writeError(res, 500, 'api_error', 'Internal proxy error');} else if (!res.writableEnded) {res.destroy();}
      this.log(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      res.removeListener('close', onClose);
      this.inFlight.delete(ac);
    }
  }
}
