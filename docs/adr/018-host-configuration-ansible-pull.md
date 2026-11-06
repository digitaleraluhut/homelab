# ADR-018: Host configuration with Ansible, pulled by the host

**Status:** Implemented

## Context

Everything in the cluster is Pulumi code, but the node itself was configured by
hand: the AI operator account and its sudo whitelist, the Claude Code
remote-control service, and the local AI services (llama.cpp, whisper,
ComfyUI) running as systemd user units outside Kubernetes. Hand-made state
cannot be reviewed, reproduced or recovered, and on this host it had already
drifted (a service checkout carried commits that existed nowhere else).

The host is also where the AI operator lives. Whatever configures the host
must not let the operator widen its own rights: its sudo whitelist has to be
code that only the owner can approve.

Options considered:

- **Shell scripts:** no idempotence, no diff before change.
- **Pulumi:** fits the rest of the repo, but has no good model for packages,
  files and systemd units on a single host, and would need inbound SSH
  credentials in CI.
- **Ansible, push from CI:** needs SSH credentials to root on the host in CI.
- **Ansible, pulled by the host:** no inbound credentials; the host fetches the
  reviewed default branch and applies it locally.

## Decision

We will describe the host in an Ansible playbook under `host/` and apply it
with a root systemd timer on the host (`homelab-host-apply`). The timer pulls
`main`, so only reviewed changes take effect. Every file under `host/` is
CODEOWNERS-protected, including the operator's sudo whitelist.

- The file `host/mode` (`check` | `apply`) decides whether a run only reports
  the diff (`--check --diff`) or applies it. New roles are adopted in `check`
  mode first, until the diff contains only intended changes.
- The runner role is always applied, so changes to the runner itself and a
  switch back to `check` take effect on the next run.
- Ansible describes desired state only. One-off actions (deleting an account,
  moving data) are done by hand and are not encoded as roles.
- The AI services stay host units (not Kubernetes). They are being moved to a
  dedicated unprivileged user and a service checkout pinned in this repo
  (local-ai#7, #60).

## Consequences

- Host changes are PRs with CI (`ansible-lint`, syntax check, `visudo`
  validation of the rendered sudoers file). They reach the host within about ten
  minutes of merge.
- Hand edits to managed files are reverted by the next run.
- Bootstrapping a reinstalled host takes three commands (see
  [manage-host-config](../howto/manage-host-config.md)).
- `claude-remote.service` is never restarted by Ansible, because a restart ends
  the operator's session. Unit changes take effect at the next manual restart
  or reboot.
- Secrets are not managed by the playbook. Files that hold tokens (e.g. the
  operator kubeconfig) are installed by hand.
