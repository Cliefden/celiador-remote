# Changelog

## 0.4.0

- Agents run only in trusted workspaces. In Restricted Mode the window offers no repositories to the phone or the task queue and refuses to start a run, with a link to trust the folder; the status bar shows a shield. When a folder is trusted after the window opened, its runs use only your user settings: a notification names the commands the repository's `.claude` settings would run and offers "Load Repository Settings" for the next run.
- The phone's file explorer is stricter: `.git` is never listed, read or written; `.vscode`, `.claude`, `.mcp.json`, `.envrc` and `.gitmodules` are read-only; symbolic links are resolved and must stay inside the repository; edits need a trusted workspace.
- New setting `celiador.remote.allowPhoneEdits` (default on): turn it off to make the phone's file explorer read-only.
- The Claude Code CLI downloaded on first run is verified against the hash that ships with the extension, and the exact version the agent SDK expects is preferred over another installed `claude`.
- "Approve and merge" on the phone merges the task's own pull request even after the worktree has moved on; finished tasks push amended or rebased branches, report the pull request's size, and write the pull request description from the agent's summary and self-review, as the Celiador editor does.
- Release builds are published to Open VSX with trusted publishing.

## 0.3.0

- Anonymous usage events (TelemetryDeck), only while the editor's telemetry setting is on. See "Telemetry" in the README for exactly what is sent.

## 0.2.0

- A window on a folder of repositories (a project folder, `~/code`) now offers every repository directly inside it to the phone, instead of none. Runs started from the phone use that repository's folder.
- Git worktrees opened as a folder are recognised.

## 0.1.0

First release.

- Sign in with a Celiador account (email and password, magic link, GitHub).
- Repositories open in the editor are reachable from the Celiador iPhone app and the GitHub issue queue.
- Queued tasks run in their own git worktree with a Claude agent, mirrored to the phone for approvals, questions, file browsing and review; the branch is pushed and a pull request opened when the run ends; merge from the phone.
- Start a run from the command palette; cancel; list runs.
- The Claude Code CLI is used from the machine when installed, else downloaded once.
