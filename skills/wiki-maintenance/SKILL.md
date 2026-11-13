---
name: wiki-maintenance
description: Keep the private homelab wiki (digitaleraluhut/homelab-wiki, rendered at wiki.no-panic.org) current. Use (1) whenever a decision about the homelab is taken or changed during a session, (2) after merged/deployed changes that alter how the homelab works (infra, apps, access, CI, secrets handling, host), (3) after an incident was resolved or a runbook turned out missing or wrong, and (4) as a short retro at the end of a homelab work session ("retro", "Session abschließen", "wiki pflegen"), and (5) whenever you create something lasting that must be kept current (a talk, a routine, a script, a data file). Records current state and runbooks only; open items become GitHub issues.
---

# Wiki maintenance

The wiki is the shared memory of the homelab for agents and the owner: **what is**, and **how to operate it**.
Format, page conventions and sensitivity rules live in the repo's `AGENTS.md` — read it before writing.
This skill covers *when* to update and *what* goes in.

## When

| Trigger | Do |
|---|---|
| A decision is taken or changed (by the owner, or agreed in the session) | Update the affected page(s) right away, while the reasoning is fresh: the decision as current state, date, who decided, link to the PR/issue/message. Replace the superseded statement — history belongs in `log.md`, not on the page. |
| A change is merged **and** deployed/observed | Update state pages; adjust runbooks the change affects. |
| An incident was diagnosed and fixed, or a runbook was missing/wrong | Fix or add the runbook (steps that actually worked). Use the incident as a worked example if it helps. |
| You created something lasting that must be kept current (a talk, a routine, a script, a data file, a page) | In the same commit, add an `upkeep` entry (`what`, `when`) to the frontmatter of the page that describes it. `wiki/maintenance.md` is generated from these entries by the pre-commit hook (`git config core.hooksPath .githooks` once per clone); never edit it by hand. |
| Session start, or a milestone that may make something due | Read the section "What the operator keeps current" (shown at session start) and do what is due. |
| End of a homelab session | Run the retro below. |

Not a trigger: unmerged branches, plans, speculation, transient states that are being fixed right now
(state them only if they persist; tracking goes to an issue).

## What goes in — and what does not

**In:** verified current state (with source and date), decisions in force (with rationale in one or two
sentences and a link), runbooks/guides an agent can execute, how to diagnose things, where things live
(repos, files, namespaces, secret *locations*).

**Not in:** todos, known issues, open questions/decisions, roadmaps → GitHub issues
(public repo if not sensitive; this private repo if sensitive, without values). No secret values, tokens, keys,
e-mails, IPs, tailnet names, account IDs. No chat transcripts or session narratives.

## Retro (end of session, ~5 minutes)

1. **Collect** — from the session: merged PRs, deployments, decisions, incidents, surprises, things that took
   long because knowledge was missing.
2. **Ask the owner briefly** (one message, three bullets): what changed / what did we decide / what is still
   open. Skip if the session already made it obvious.
3. **Verify** before writing, read-only: `gh pr view`, `gh run list`, `KUBECONFIG=~/.kube/config kubectl get …`,
   `sudo -n crictl ps`. Mark anything you could not verify as unverified.
4. **Open items → issues.** Search first: `gh issue list -R <repo> --search "<keywords>" --state all`.
5. **Write** (see "How").
6. **Report** to the owner in 3–5 lines: pages changed, issues filed, link to the wiki.

## How

1. Work in a checkout of `digitaleraluhut/homelab-wiki` (`git pull` first). On the node the canonical checkout is
   `~/projects/digitaleraluhut/homelab-wiki`; do not use another session's working tree.
2. Follow `AGENTS.md`: frontmatter (`updated:`, `sources:`), wikilinks, summary first, index entry for new pages.
3. Append to `wiki/log.md`: `## [YYYY-MM-DD] <ingest|decision|retro|runbook> | <topic>` plus 1–3 lines.
4. Raw sources: add a new dated file under `raw/` for observations that back new facts (redacted). Never edit old ones.
5. Before committing: check for leaks, e.g.
   `grep -rnE '([0-9]{1,3}\.){3}[0-9]{1,3}|@[a-z0-9-]+\.[a-z]{2,}|ts\.net|BEGIN .*PRIVATE' wiki raw`
   and, if available, `gitleaks git --redact --no-banner .`
6. Commit and push to `main` (if `main` is PR-only: open a PR and merge it yourself — wiki content needs no
   owner review unless `AGENTS.md` or this skill changes). Check that the "Build site" run is green; the cluster
   picks up the new `site` build within about a minute.

## Delegation

Large ingests (many pages) can be delegated to a separate agent session. Brief it with this skill and
`AGENTS.md`, keep the scope narrow, and review its diff before telling the owner it is done.
