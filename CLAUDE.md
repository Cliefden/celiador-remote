# CLAUDE.md

The phone loop as a stock VS Code / Cursor extension (Open VSX
`celiador.celiador-remote`). What it is and how to build it: README.md,
CONTRIBUTING.md. Much of `src/` is ported from the editor's built-in
`celiador-ai` extension (Cliefden/celiador-editor `extensions/celiador-ai/`):
keep fixes to the relay, git review and auth in sync both ways.

## Worktrees

Parallel work happens in worktrees under `.claude/worktrees/` (gitignored), one
per issue branch, through `wb` (github.com/Cliefden/workbench; the manual is
its `WORKTREES.md`). `wb issue` files an issue into Backlog, `wb start
<issue#>` takes one from the board (assigns, In progress, worktree;
`/start-issue` wraps it), `wb status` shows every worktree's issue, changes,
push/PR state and what can be removed, and `wb pr` opens the PR and moves the
issue to In review — only when the user asks, as it pushes.

- Inside a worktree, run commands from its root. Never `cd` into the main
  checkout or other worktrees to edit or run git there.
- The git stash is shared across worktrees. Set work aside with a WIP commit,
  not `git stash`.

## Pushing

- Commit freely; push only when asked. A pushed `v*` tag publishes to Open VSX
  (release.yml).
- **PRs open as drafts**, which run no CI (`wb pr`); run `npm run typecheck`
  and `npm run build` locally, then `gh pr ready` once. PRs land in merge
  trains (`wb train`), not with `gh pr merge`; `wb train land` pushes `main`:
  only when asked.
- **The repo is public.** An exploitable security problem goes into a private
  security advisory, never an issue; its fix PR uses neutral wording, no
  advisory id and no closing keyword. Its worktree is a plain branch (`wb new
  <name>`), shown as "(no issue)".
- **Never put the `celiador` label on an issue**: it starts an agent run.
