---
name: git-workflow
description: "Before committing, rewriting, pushing or merging in the operator's repositories: hooks in worktrees, keep commit bodies, check PRs and merges."
---
# Git workflow in the operator's repositories

The commit format itself is the `commit` skill. These are the steps that broke it before.

- **Worktrees:** run `npx --no-install husky` once in every new worktree, so the commit hooks (format,
  gitleaks) run.
- **Commit with** `git commit --cleanup=verbatim -F <file>`; keep the message file outside the
  repository. A rebase, amend or cherry-pick that rewrites messages needs `--cleanup=verbatim` too,
  otherwise the `## Intent` lines are stripped as comments. On PR branches, merge `origin/main`
  instead of rebasing.
- **Before pushing:** the PR of the branch must be open (`gh pr view <branch> --json state`); a
  merged branch swallows new commits. Count the commits with `## Intent`; it must equal the number of
  commits ahead of main.
- **Merging:** always name the PR (`gh pr merge <n>`), then confirm `gh pr view <n> --json state` is
  MERGED before deploying anything from main.
- **After a merge:** verify where it takes effect (deploy run, host units, deployed revision) before
  reporting it done.
