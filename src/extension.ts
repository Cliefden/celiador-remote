/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Auth } from './auth';
import { ClaudeExecutable } from './cli';
import { Control } from './control';
import { resolveDaemonUrl } from './daemonUrl';
import { registerGitReview, registerTaskCommands } from './gitReview';
import { openRepos, Presence } from './presence';
import { DaemonProxy } from './proxy';
import { bucket, initTelemetry, signal } from './telemetry';

// Celiador Remote: run Claude agents on the repositories open in this editor,
// started and reviewed from the Celiador iPhone app or a labelled GitHub issue.
// Sign in with a Celiador account; the agent's usage goes through celiador.ai.

export function activate(context: vscode.ExtensionContext): void {
  if (/celiador/i.test(vscode.env.appName)) {
    // The Celiador editor has all of this built in; two copies would fight over the same runs.
    void vscode.window.showInformationMessage('Celiador Remote is for VS Code and Cursor. This editor already has the phone loop built in, so the extension stays off here.');
    return;
  }
  initTelemetry(context);
  const output = vscode.window.createOutputChannel('Celiador');
  const log = (message: string) => output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  const auth = new Auth(context.secrets);
  const getToken = async () => {
    try {return await auth.getAccessToken();} catch {return undefined;}
  };
  const daemonUrl = () => resolveDaemonUrl();
  const proxy = new DaemonProxy(() => `${daemonUrl()}/api/anthropic`, getToken, log);
  const presence = new Presence(daemonUrl, getToken, log);
  const claude = new ClaudeExecutable(context, log);
  const control = new Control({ daemonUrl, getToken, proxy, claudeExecutable: () => claude.get(), log }, output, getToken);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'celiadorRemote.showRuns';

  const refreshStatus = async () => {
    const email = await auth.currentEmail();
    const runs = control.activeRuns.filter((r) => r.status === 'running' || r.status === 'awaiting');
    const awaiting = runs.filter((r) => r.status === 'awaiting').length;
    if (!email) {
      status.text = '$(cloud) Celiador: sign in';
      status.tooltip = 'Sign in to Celiador to run agents from your phone';
      status.command = 'celiadorRemote.signIn';
    } else if (awaiting) {
      status.text = `$(bell) Celiador: ${awaiting} waiting`;
      status.tooltip = 'An agent is waiting for an approval or an answer (phone or editor)';
      status.command = 'celiadorRemote.showRuns';
    } else if (runs.length) {
      status.text = `$(sync~spin) Celiador: ${runs.length} running`;
      status.tooltip = 'Agent runs in progress';
      status.command = 'celiadorRemote.showRuns';
    } else {
      status.text = '$(cloud) Celiador';
      status.tooltip = `Signed in as ${email}. ${openRepos().length} repositories reachable from your phone.`;
      status.command = 'celiadorRemote.showRuns';
    }
    status.show();
  };

  context.subscriptions.push(
    output, status, presence, control,
    { dispose: () => proxy.dispose() },
    auth.onDidChange(() => { void refreshStatus(); void presence.beat(); }),
    control.onDidChangeRuns(() => void refreshStatus()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshStatus()),
    registerGitReview(),
    registerTaskCommands(),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path !== '/auth-callback') {return;}
        try {
          if (await auth.handleCallback(uri)) {
            signal({ type: 'celiador/signedIn', payload: { method: 'link' } });
            void vscode.window.showInformationMessage(`Signed in to Celiador as ${await auth.currentEmail() ?? 'you'}.`);
          }
        } catch (err) {
          void vscode.window.showErrorMessage(`Celiador sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    vscode.commands.registerCommand('celiadorRemote.signIn', () => signIn(auth)),
    vscode.commands.registerCommand('celiadorRemote.signOut', async () => {
      await auth.signOut();
      void vscode.window.showInformationMessage('Signed out of Celiador.');
    }),
    vscode.commands.registerCommand('celiadorRemote.startRun', async () => {
      if (!(await auth.isSignedIn())) {return signIn(auth);}
      const repos = openRepos();
      const folder = repos.length > 1
        ? (await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, description: r.remoteUrl, repo: r })), { title: 'Run an agent on…' }))?.repo
        : repos[0];
      const root = folder?.folder.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showWarningMessage('Open a folder first.');
        return;
      }
      const prompt = await vscode.window.showInputBox({ title: 'What should the agent do?', placeHolder: 'Fix the flaky test in auth.spec.ts', ignoreFocusOut: true });
      if (!prompt?.trim()) {return;}
      control.startLocalRun(root, prompt.trim().slice(0, 80), prompt.trim());
      signal({ type: 'celiador/localRun', payload: {} });
      output.show(true);
    }),
    vscode.commands.registerCommand('celiadorRemote.cancelRun', async () => {
      const runs = control.activeRuns.filter((r) => r.status === 'running' || r.status === 'awaiting');
      if (!runs.length) {
        void vscode.window.showInformationMessage('No agent is running.');
        return;
      }
      const pick = runs.length === 1 ? runs[0] : (await vscode.window.showQuickPick(runs.map((r) => ({ label: r.options.title, description: r.options.root, run: r })), { title: 'Cancel which run?' }))?.run;
      pick?.cancel();
    }),
    vscode.commands.registerCommand('celiadorRemote.showRuns', async () => {
      const runs = control.activeRuns;
      if (!runs.length) {
        const choice = await vscode.window.showInformationMessage('No agent runs yet. Start one here, or from your phone.', 'Run an Agent…', 'Open the Start Guide');
        if (choice === 'Run an Agent…') {void vscode.commands.executeCommand('celiadorRemote.startRun');}
        if (choice === 'Open the Start Guide') {void vscode.commands.executeCommand('celiadorRemote.openStartGuide');}
        return;
      }
      const pick = await vscode.window.showQuickPick(runs.map((r) => ({
        label: `${statusIcon(r.status)} ${r.options.title}`,
        description: r.options.root,
        detail: r.lastText ? r.lastText.slice(0, 160).replace(/\s+/g, ' ') : undefined,
        run: r,
      })), { title: 'Agent runs' });
      if (pick) {output.show(true);}
    }),
    vscode.commands.registerCommand('celiadorRemote.openStartGuide', () => vscode.env.openExternal(vscode.Uri.parse('https://celiador.ai/start'))),
  );
  void refreshStatus();
  void auth.isSignedIn().then((signedIn) => {
    if (signedIn) {signal({ type: 'celiador/remoteActive', payload: { editor: vscode.env.appName, repos: bucket(openRepos().length) } });}
  }, () => undefined);
  log(`Celiador Remote active; daemon ${daemonUrl()}; ${openRepos().length} repositories with a GitHub origin`);
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running': return '$(sync~spin)';
    case 'awaiting': return '$(bell)';
    case 'done': return '$(check)';
    case 'error': return '$(error)';
    default: return '$(circle-slash)';
  }
}

async function signIn(auth: Auth): Promise<void> {
  const method = await vscode.window.showQuickPick([
    { label: '$(github) Continue with GitHub', id: 'github' },
    { label: '$(mail) Email me a sign-in link', id: 'magic' },
    { label: '$(key) Email and password', id: 'password' },
  ], { title: 'Sign in to Celiador' });
  if (!method) {return;}
  try {
    if (method.id === 'github') {
      await auth.signInWithGitHub();
      return;
    }
    const email = await vscode.window.showInputBox({ title: 'Your email', placeHolder: 'you@example.com', ignoreFocusOut: true, validateInput: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : 'Enter an email address') });
    if (!email) {return;}
    if (method.id === 'magic') {
      await auth.sendMagicLink(email.trim());
      void vscode.window.showInformationMessage(`Check ${email.trim()} for a sign-in link.`);
      return;
    }
    const password = await vscode.window.showInputBox({ title: 'Your password', password: true, ignoreFocusOut: true });
    if (!password) {return;}
    try {
      await auth.signInWithPassword(email.trim(), password);
    } catch (err) {
      if (!/invalid|credentials/i.test(err instanceof Error ? err.message : '')) {throw err;}
      const create = await vscode.window.showWarningMessage('No account with that password. Create one?', 'Create Account');
      if (create !== 'Create Account') {return;}
      const created = await auth.signUp(email.trim(), password);
      if (!created) {
        void vscode.window.showInformationMessage(`Check ${email.trim()} to confirm your account, then sign in again.`);
        return;
      }
    }
    signal({ type: 'celiador/signedIn', payload: { method: 'password' } });
    void vscode.window.showInformationMessage(`Signed in to Celiador as ${email.trim()}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Celiador sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deactivate(): void {
  /* subscriptions dispose the proxy, presence and runs */
}
