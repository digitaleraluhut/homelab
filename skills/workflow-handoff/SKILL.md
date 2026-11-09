---
name: workflow-handoff
description: Hand a GitHub Actions workflow change to the homelab owner. Use whenever a change must add, edit or delete a file under .github/workflows/ in digitaleraluhut/homelab, homelab-apps, local-ai or homelab-wiki, and whenever GitHub refuses a push with "refusing to allow a GitHub App to create or update workflow ... without `workflows` permission". The operator's GitHub App deliberately cannot push workflow files; this skill says what to do instead.
---

# Workflow handoff

The operator's GitHub App has no `workflows` permission, and that is deliberate. With it, any pushed
branch could carry its own workflow and run it with self-chosen `GITHUB_TOKEN` rights, without review.
So workflow files reach GitHub through the owner. You hand over **data only**. The owner runs the
reviewed script `homelab/scripts/apply-operator-handoff.sh`.

**Scope:** only paths under `.github/workflows/`. Everything else, including other `.github/` files such
as `apps.yaml` or `CODEOWNERS`, is a normal PR.

## Steps

1. **Keep the rest moving.** Commit and push everything except the workflow change. If a push was
   refused, remove the workflow file from the branch: `git rm --cached` or an amend, then push again.
   Do not retry the refused push and do not ask for the `workflows` permission.
2. **Write the complete file** (not a patch) to `/tmp/aioperator-handoff/<repo>/<name>.yml`.
   For an edit, start from the file as it is on the target branch.
3. **Add one line per file** to `/tmp/aioperator-handoff/handoff.tsv`, tab-separated:

   | column | value |
   |---|---|
   | repo | `homelab`, `homelab-apps`, `local-ai` or `homelab-wiki` |
   | branch | an existing branch **with an open PR**, or `new:<branch>` (new branch from main plus a new PR) |
   | file | path relative to `/tmp/aioperator-handoff/`, e.g. `homelab-apps/deploy-apps.yml` |
   | message | commit message, also the PR title for `new:` |

   The target path is always `.github/workflows/<basename>`. Delete lines that have been applied.
4. **Check it** with `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`, and make
   sure every manifest line names an existing file and an open PR branch (`gh pr view <branch>`).
5. **Tell the owner twice:** add a line to the PR description ("Workflow handoff pending: …"), and say
   in chat that `scripts/apply-operator-handoff.sh` in their homelab checkout on flinker is waiting.

## Never
- Write a script or patch for the owner to *execute*. Only files plus the manifest.
- Put anything other than workflow files into the manifest. The script rejects it anyway.
