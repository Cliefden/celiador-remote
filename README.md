# Celiador Remote

Run Claude agents on the repositories you have open in VS Code or Cursor, started and reviewed from your phone.

Label a GitHub issue `celiador` (or queue a task from the Celiador iPhone app) and this extension picks it up on your machine: it creates a git worktree on a fresh branch, runs a Claude agent there with your project's own settings, mirrors the run to your phone for approvals and questions, then pushes the branch and opens the pull request. Review the diff and merge from the phone. Your checkout is never touched.

It is the same loop the [Celiador editor](https://celiador.ai) ships built in, for people who want to keep their editor.

## What you need

- A Celiador account (sign in from the status bar; email, magic link or GitHub).
- A repository with a GitHub origin, open as a workspace folder.
- `git` on your PATH, and either the editor's GitHub sign-in or `gh auth login`, so pull requests can be opened and merged for you.
- The [Celiador iPhone app](https://celiador.ai/start) to drive runs from your phone (optional: the command palette works too).

The agent's usage goes through celiador.ai with your account's limits; no Anthropic key is needed on your machine, and one found in your environment is not used.

## Commands

| Command | What it does |
|---|---|
| Celiador: Sign In / Sign Out | Account for this editor |
| Celiador: Run an Agent on This Repository… | Start a run from the keyboard; the phone can still watch and steer it |
| Celiador: Cancel the Running Agent | Stop a run |
| Celiador: Show Agent Runs | Runs in this window and their state; opens the Celiador output |
| Celiador: Open the Start Guide | celiador.ai/start |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `celiador.agentTasks.permissionMode` | `auto` | `auto`: Claude decides per tool call; routine commands run, risky ones ask on the phone and in the editor. `default`: every tool call asks. |
| `celiador.agentTasks.issueComment` | `true` | Comment on the GitHub issue when its run starts (not needed when the Celiador GitHub App is installed on the repo). |
| `celiador.agentTasks.attribution` | `false` | Add a "made with Celiador" line to pull requests from agent runs. |
| `celiador.daemonUrl` | empty | Self-hosting the daemon? Point this at it. User scope only. |

## How it works

```
phone / GitHub issue ─▶ celiador.ai (queue + relay) ─▶ this extension
                                                        ├─ git worktree <repo>.worktrees/<branch>
                                                        ├─ Claude Agent SDK session (cwd = worktree)
                                                        │    API calls → loopback proxy → celiador.ai gateway
                                                        └─ relay: events up, approvals/questions/review down
                                              ◀─ push + pull request (your git identity, your GitHub sign-in)
```

- The Claude subprocess never holds your Celiador token: it gets a one-off session nonce for a loopback proxy in the extension, which attaches your current token to each request (tokens rotate hourly; a run survives that).
- Settings come from your user, project and local Claude settings (`settingSources`), so your CLAUDE.md, hooks and MCP servers apply.
- The worktree is created from `origin/<default branch>` after a fetch, on the task's branch (suffixed if taken).
- The Claude Code CLI itself is not in the VSIX (its native binary is about 270 MB). The extension uses a `claude` already installed on the machine, or downloads the exact version the SDK expects into its global storage the first time an agent runs.

## Building

```sh
npm install
npm run typecheck
npm run build          # dist/extension.js (esbuild, CommonJS; the SDK stays external and loads with import())
npm run package        # celiador-remote-<version>.vsix
```

Develop with `code --extensionDevelopmentPath=$PWD <a repo>` (or Cursor).

## Licence

Apache-2.0. Ports the relay client, auth and git review modules of the Celiador editor's `celiador-ai` extension.
