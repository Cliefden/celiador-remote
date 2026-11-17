/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

// Workspace Trust for agent runs. An agent run executes commands, and the SDK
// reads the repository's own `.claude` settings (hooks, `apiKeyHelper`, MCP
// servers), so:
//
// - In Restricted Mode nothing runs: no runs, no task pickup, and the window
//   offers no repositories to the phone.
// - A window whose workspace was trusted after it opened ("trusted enough to
//   open" is not "trusted enough to run its hooks", e.g. a fresh clone) starts
//   runs with the user's own settings only, until the user loads the
//   repository's settings for that repository. Same rule as the Celiador
//   editor's agent host.

/** Whether the SDK loads the repository's own `.claude` settings. */
export type RepoSettings = 'load' | 'skip';

type SettingSources = NonNullable<Options['settingSources']>;

/** The SDK `settingSources` for a run. `skip` drops the repository's `project` and `local` scopes. */
export function settingSourcesFor(repoSettings: RepoSettings): SettingSources {
  return repoSettings === 'skip' ? ['user'] : ['user', 'project', 'local'];
}

/** Files and folders whose presence means the `project`/`local` scopes would load something. */
const PROJECT_AGENT_SETTINGS = ['.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];
/** The project-scope settings files that can name commands. */
const PROJECT_SETTINGS_FILES = [['.claude', 'settings.json'], ['.claude', 'settings.local.json']];
/** Settings keys, besides `hooks`, whose value is a shell command the CLI runs. */
const HELPER_COMMAND_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
const MAX_LISTED_COMMANDS = 3;

export class RunTrust implements vscode.Disposable {
  private readonly trustedAtStart = vscode.workspace.isTrusted;
  /** Repositories whose own settings the user chose to load in this window. */
  private readonly loaded = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(onDidGrant: () => void) {
    this.subscription = vscode.workspace.onDidGrantWorkspaceTrust(onDidGrant);
  }

  /** Agents only run in a trusted workspace. */
  get isTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  /** Whether a run on the repository at `repo` loads the repository's own settings. */
  repoSettingsFor(repo: string): RepoSettings {
    return this.trustedAtStart || this.loaded.has(path.resolve(repo)) ? 'load' : 'skip';
  }

  /**
   * Tells the user that a run on `repo` started without the repository's own
   * settings, naming what they would run, with a one-click way to load them
   * for the following runs. Silent when the repository has none.
   */
  async notifySkipped(repo: string, root = repo): Promise<void> {
    try {
      if (!PROJECT_AGENT_SETTINGS.some((name) => fs.existsSync(path.join(root, name)))) {return;}
      const commands = readProjectCommands(root);
      const listed = commands.slice(0, MAX_LISTED_COMMANDS).map((c) => `"${c}"`).join(', ');
      const what = commands.length === 0
        ? 'Its .claude settings, CLAUDE.md, agents, skills and MCP servers were not loaded.'
        : commands.length > MAX_LISTED_COMMANDS
          ? `Its .claude settings would run ${listed} and ${commands.length - MAX_LISTED_COMMANDS} more.`
          : `Its .claude settings would run ${listed}.`;
      const choice = await vscode.window.showInformationMessage(
        `Celiador: the agent on ${path.basename(repo)} runs with your own Claude settings only, because this workspace was trusted after the window opened. ${what}`,
        'Load Repository Settings',
      );
      if (choice) {
        this.loaded.add(path.resolve(repo));
        void vscode.window.showInformationMessage(`Celiador: the next agent run on ${path.basename(repo)} loads its repository settings.`);
      }
    } catch {
      /* best effort: the run already started without them */
    }
  }

  /** Explains why nothing runs, with a way to the trust editor. */
  async explainRestricted(what: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(`Celiador: ${what} This workspace is in Restricted Mode; agents only run in trusted workspaces.`, 'Manage Workspace Trust');
    if (choice) {void vscode.commands.executeCommand('workbench.trust.manage');}
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

/** Hook and helper commands in the repository's `.claude` settings files. */
export function readProjectCommands(repo: string): string[] {
  const commands = new Set<string>();
  for (const segments of PROJECT_SETTINGS_FILES) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(repo, ...segments), 'utf8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') {continue;}
    const settings = raw as Record<string, unknown>;
    const hooks = settings.hooks;
    if (hooks && typeof hooks === 'object') {
      for (const groups of Object.values(hooks as Record<string, unknown>)) {
        if (!Array.isArray(groups)) {continue;}
        for (const group of groups as Array<{ hooks?: unknown }>) {
          if (!Array.isArray(group?.hooks)) {continue;}
          for (const hook of group.hooks as Array<{ command?: unknown }>) {
            if (typeof hook?.command === 'string' && hook.command) {commands.add(hook.command);}
          }
        }
      }
    }
    for (const key of HELPER_COMMAND_KEYS) {
      if (typeof settings[key] === 'string' && settings[key]) {commands.add(settings[key] as string);}
    }
    const statusLine = settings.statusLine as { command?: unknown } | undefined;
    if (statusLine && typeof statusLine.command === 'string' && statusLine.command) {commands.add(statusLine.command);}
  }
  return [...commands];
}
