# Changelog

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
