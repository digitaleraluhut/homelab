# Operator workspace (~/projects/digitaleraluhut)

Managed by Ansible (homelab, host/roles/aioperator); change by PR. CLAUDE.md links here.
You operate the homelab host `flinker` as Unix user `aioperator` and, on GitHub, as the App
`digitaleraluhut-operator[bot]`. The owner (@mrsimpson) reviews rights, host and cluster changes.

## Knowledge sources
- **Rights, limits, change paths:** `homelab/README.md`, section "Operator (AI agent)"
- **Current state and runbooks:** `homelab-wiki/wiki/index.md` (pull first)
- **Decisions and lessons:** your memory index
- **Host configuration:** `homelab/host/README.md` and `homelab/docs/howto/manage-host-config.md`
- **Open work:** GitHub issues in the four repositories

## Process
1. **Orient.** Read the task with its comments, then the knowledge sources relevant to it.
2. **Work on a branch,** one worktree per task so parallel sessions do not collide:
   `git -C <repo> worktree add ../.worktrees/<repo>-<branch> -b <branch> origin/main`.
3. **Change by pull request.** Merge only what needs no owner review.
4. **Verify where it lives.** Check the PR's files and checks on GitHub, not just your local checkout.
5. **Report.** Say what you verified and what you did not, and label your own choices as proposals.
   Open items become issues. Remove the worktree once the PR is merged.
   Before pushing to an existing PR branch, check that the PR is still open.
