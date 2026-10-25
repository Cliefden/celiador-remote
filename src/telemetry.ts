/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';

// Product telemetry via TelemetryDeck, the same app (and anonymous-user
// scheme) as the Celiador editor and iPhone app, so all three land in one
// dashboard. A short allowlist of events with the parameters listed below and
// nothing else: never code, prompts, repository names, paths or the account.
// Sent only while VS Code's telemetry setting allows it (`vscode.env.isTelemetryEnabled`,
// which Cursor and other forks honour too); best-effort, batched, never retried.

const APP_ID = 'F1064ED9-9413-4478-8753-20DC53104F78';
const SALT = 'celiador-remote';
const TARGET = 'https://nom.telemetrydeck.com/v2/';
const FLUSH_DELAY_MS = 10_000;
const MAX_QUEUE = 100;

/** The events this extension may send, and the parameters each carries. */
export type TelemetryEvent =
  /** The extension started in a signed-in editor. `editor`: the host app name (Visual Studio Code, Cursor, …); `repos`: 0, 1, 2-5 or 6+. */
  | { type: 'celiador/remoteActive'; payload: { editor: string; repos: string } }
  /** Sign-in completed. `method`: password, link (GitHub or magic link). */
  | { type: 'celiador/signedIn'; payload: { method: 'password' | 'link' } }
  /** A run was started from the phone. `seeded`: a first prompt came with it; `nested`: the repo is inside an open folder rather than one. */
  | { type: 'celiador/phoneRun'; payload: { seeded: 'true' | 'false'; nested: 'true' | 'false' } }
  /** A run was started from the command palette. */
  | { type: 'celiador/localRun'; payload: Record<string, never> }
  /** A queued task finished. `result`: pr-open, failed, cancelled. */
  | { type: 'celiador/taskRun'; payload: { result: 'pr-open' | 'failed' | 'cancelled' } };

let context: { clientUser: string; sessionId: string; version: string; testMode: boolean } | undefined;
let queue: object[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** Call once on activation. */
export function initTelemetry(extension: vscode.ExtensionContext): void {
  context = {
    clientUser: createHash('sha256').update(vscode.env.machineId + SALT).digest('hex'),
    sessionId: randomUUID(),
    version: String(extension.extension.packageJSON.version ?? '0'),
    testMode: extension.extensionMode !== vscode.ExtensionMode.Production,
  };
  extension.subscriptions.push({ dispose: () => void flush() });
}

export function signal(event: TelemetryEvent): void {
  if (!context || !vscode.env.isTelemetryEnabled) {return;}
  queue.push({
    clientUser: context.clientUser,
    sessionID: context.sessionId,
    appID: APP_ID,
    type: event.type,
    telemetryClientVersion: `celiador-remote ${context.version}`,
    receivedAt: new Date().toISOString(),
    ...(context.testMode ? { isTestMode: true } : {}),
    payload: {
      'TelemetryDeck.AppInfo.version': context.version,
      'TelemetryDeck.Device.platform': process.platform,
      ...event.payload,
    },
  });
  if (queue.length > MAX_QUEUE) {queue.splice(0, queue.length - MAX_QUEUE);}
  timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

/** Bucket a count so small numbers don't fingerprint anyone. */
export function bucket(n: number): string {
  return n === 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : '6+';
}

async function flush(): Promise<void> {
  if (timer) {clearTimeout(timer);}
  timer = undefined;
  if (!queue.length) {return;}
  const batch = queue;
  queue = [];
  try {
    await fetch(TARGET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
  } catch {
    /* dropped on purpose: telemetry never retries */
  }
}
