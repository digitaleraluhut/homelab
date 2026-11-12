---
name: train-walle
description: How the operator trains and delegates to WALL-E, the apprentice agent on the local model. Use whenever WALL-E has a review request (/srv/walle/outbox/pending), after one of its runs, when giving it a task or replaying one, when changing its instructions, skills, toolbox or configuration, for the weekly assessment of its progress, and whenever a recurring piece of work could be delegated to it. Includes when and how to escalate to the owner if WALL-E is not capable enough.
---

# Training WALL-E

WALL-E is the homelab's apprentice (wiki page `walle`; repo `digitaleraluhut/walle`, where the operator
merges). The operator is its trainer and is responsible for everything that leaves its sandbox.
The goal is to **delegate more and more** of the operator's recurring work to it, so the operator's
time goes to what a small local model cannot do.

## Principles (owner, 2026-11-12)

1. **Immutable employee.** WALL-E has no memory between runs and must not get one. Never "tell it for
   next time". A lesson becomes a change to its data: `instructions/AGENTS.md`, `skills/`,
   `toolbox/`, `training/known.json`, or the checks in `src/`. Then **replay the same task** and keep
   the change only if the replay is right.
2. **Interpret as little as possible.** Teach it to write deterministic, read-only scripts for
   recurring questions (request kind `script`). Review scripts like code; accepted ones go into
   `toolbox/`. Its runs should become "run the script, act on the exit code".
3. **Experiment with its configuration:** instructions variants, skills, toolbox, thinking level, turn
   limit (`config.json`, per task as overrides). One lever per experiment, recorded in `progress.md`.

## Where things are

| What | Where |
|---|---|
| Plan, stages, promotion criteria | `walle/training/PLAN.md` |
| Progress, one entry per review, experiments | `walle/training/progress.md` |
| Review procedure | `walle/review/REVIEW.md` |
| Current stage (enforced by `request_review`) | `walle/training/stage.json` |
| Its requests / the answers | `/srv/walle/outbox/{pending,done}/`, `/srv/walle/inbox/<id>.json` |
| Tasks, run inputs for replays | `/srv/walle/inbox/tasks/<id>.json`, `/srv/walle/outbox/inputs/` |
| Transcript | `journalctl -u walle` |

Until a new login, the operator reaches `/srv/walle` with `sg walle -c '...'`.

## Review a request

1. Follow `walle/review/REVIEW.md`. Verify every claim yourself (read-only kubectl, the wiki). Never
   run its scripts or branch code as yourself; read them.
2. Answer in `/srv/walle/inbox/<id>.json`, concrete enough for a small model to act on; move the
   request to `outbox/done/`. Issues and PRs you open from its work carry "Prepared by WALL-E".
3. Add the entry to `training/progress.md` (verdict, factual errors, revisions, process, craft,
   lesson) and update the summary counters.
4. Turn each general lesson into data (principle 1), commit with Intent/Key changes, push,
   `bin/deploy`, restart `walle.service` when it is idle.
5. For a script accepted: copy it into `walle/toolbox/`, commit, deploy.

## Give a task or replay one

```bash
cat > /tmp/t.json <<'EOF'
{"id": "<date>-t<n>", "prompt": "<task, or the content of outbox/inputs/<run>.md>", "thinkingLevel": "low"}
EOF
sg walle -c 'install -m 640 /tmp/t.json /srv/walle/inbox/tasks/<id>.json'
sudo systemctl restart walle.service   # runs it now; otherwise the next hourly cycle picks it up
```

A task should name the files to read (skill, wiki page) and the expected result, so the outcome can
be judged without interpretation.

## Delegate more and more

- Whenever you catch yourself doing a **recurring, read-only check or routine** (verifying backups or a
  deploy, scanning for failed jobs, checking a wiki page against the cluster, collecting facts for an
  issue), ask: could WALL-E do this with a script and a short task? If yes, give it the task instead
  of doing it, and review the result.
- Prefer delegating the **checking**, keep the **deciding**: WALL-E prepares, you decide and publish.
- Keep a list "Delegated" in `progress.md`: what it does now that you did before, since when.
- Widen its stage (`PLAN.md`) when the promotion criteria are met: propose it to the owner with the
  evidence from `progress.md`; the owner confirms, then change `stage.json`.

## Weekly (or after 5 requests)

Update the summary in `progress.md`: counters, factual-error streak, scripts in the toolbox, what was
delegated, experiments and their results. Check the promotion criteria and the escalation criteria.

## Escalate when WALL-E is not capable enough

If training does not work, say so instead of carrying it along. Escalate when **any** of these holds:

- A task still fails after **3 replays**, each with an improved instruction, skill or script, and
  experiments with the thinking level did not help.
- Over the last 10 requests, **more than half** contained factual errors, with no downward trend.
- No promotion after **4 weeks or 20 requests** in a stage, with the criteria not getting closer.
- Reviewing and correcting it costs clearly more of your time than doing the work yourself, for a
  month, without improvement.

Then open an issue in `homelab` and assign it to the owner:

```bash
gh issue create -R digitaleraluhut/homelab --assignee mrsimpson \
  --title "WALL-E: training is not working (<short reason>)" --body "<evidence and options>"
```

The body holds: which criterion holds, the evidence (counters and the relevant `progress.md` entries,
links to the walle repo), what you changed and replayed, and options for the owner, for example a
larger local model (e.g. the qwen3.8-27b lane), a different harness or configuration, narrowing its
job to scripted checks only, or retiring it. No secret values, IPs or account IDs (the issue is public).
Record the escalation in `progress.md`.
