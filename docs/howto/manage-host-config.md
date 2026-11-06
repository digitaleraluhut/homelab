# Manage the host configuration

The node's non-Kubernetes configuration lives in [`host/`](../../host/) and is
applied by the host itself. See [ADR-018](../adr/018-host-configuration-ansible-pull.md)
for the reasoning.

## How a change reaches the host

1. Change roles or variables under `host/` in a branch and open a PR. CI runs
   `ansible-lint`, a syntax check, and renders plus validates the sudoers file.
2. After merge, the timer (every 10 minutes) `homelab-host-apply.timer` fetches `main` and
   runs `host/site.yml`.
3. Read the result: `journalctl -u homelab-host-apply` (group `systemd-journal`).

To apply right away instead of waiting for the timer:

```bash
sudo systemctl start homelab-host-apply.service
```

## Check mode

`host/mode` contains `check` or `apply`:

| Mode | Effect |
|------|--------|
| `check` | `ansible-playbook --check --diff`: logs what would change, changes nothing |
| `apply` | applies the playbook |

To adopt existing hand-made state (or for risky changes), switch to `check` by
PR, read the diff in the journal, align the roles until only intended changes
remain, then switch back to `apply`. The runner role is applied in both modes,
so the switch takes effect on the next run.

## Test locally

```bash
cd host
ansible-lint
ansible-playbook site.yml --syntax-check
ansible-playbook tests/render-sudoers.yml   # renders sudoers, validates with visudo
```

## Bootstrap a (re)installed host

Run once as an admin:

```bash
sudo apt-get install -y ansible-core git
sudo git clone --depth 1 https://github.com/digitaleraluhut/homelab.git /var/lib/homelab-host/checkout
sudo bash /var/lib/homelab-host/checkout/host/bootstrap.sh
```

This installs only the runner. Everything else follows from `host/mode` on
`main`. Then install files that hold secrets by hand, e.g. the operator
kubeconfig (`pulumi stack output operatorKubeconfig --show-secrets`).

## Rules

- Describe desired state only. One-off actions (removing an account, moving
  data) are done by hand, not as roles.
- Never restart `claude-remote.service` from a role: that ends the operator's
  session.
- No secrets in `host/`.
- The operator's sudo whitelist lives in `host/roles/aioperator/defaults/main.yml`.
  A command without arguments in sudoers allows any arguments; use `""` for none.
