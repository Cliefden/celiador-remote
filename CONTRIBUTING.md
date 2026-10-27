# Contributing to Celiador Remote

Work starts as a GitHub issue. Label it `celiador` and an agent picks it up in its own worktree and opens the PR; review it from the phone or the Agents view. Every change to Celiador ships through Celiador.

Write the issue the way you would brief a colleague: what to change, where, and what not to touch. The agent comments on the issue when it is picked up and again with the pull request link. If you would rather do the change by hand, open a pull request against `main` that references the issue; it goes through the same review.

Before a pull request merges:

- `npm run typecheck` and `npm run build` pass.
- The README's install and usage facts still match the extension (commands, settings, what the VSIX does and does not contain).
- A user-visible change gets a line in `CHANGELOG.md`.

Releases are tag-driven; see the release workflow under `.github/`.
