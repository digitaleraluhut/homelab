# host/ – configuration of the homelab host (Ansible)

Everything on `flinker` that is not Kubernetes: users, sudo, systemd units,
host services. The cluster and GitHub stay in Pulumi.
Why: [ADR-018](../docs/adr/018-host-configuration-ansible-pull.md). Operating it: [manage-host-config](../docs/howto/manage-host-config.md).

## How it is applied

A root systemd timer (`homelab-host-apply.timer`, every 10 minutes) runs
`/usr/local/sbin/homelab-host-apply`:

1. shallow-fetches `main` of this repo into `/var/lib/homelab-host/checkout`,
2. applies the `runner` role (the runner keeps itself up to date),
3. runs the rest of `site.yml` according to [`mode`](mode):
   - `check`: `--check --diff`, reports what would change, changes nothing;
   - `apply`: applies.

Only merged, reviewed changes reach the host: the host pulls, nothing pushes
to it, and every file here is CODEOWNERS-protected. That includes the
operator's own sudo whitelist.

Logs: `journalctl -u homelab-host-apply` (readable for the `systemd-journal`
group).

## Roles

| Role | Manages |
|---|---|
| `runner` | ansible-core, git, the runner script, service and timer |
| `aioperator` | user `aioperator`, its sudo whitelist (validated with `visudo`), `claude-remote.service`, agent-skill checkout and symlinks, Claude Code managed settings `/etc/claude-code/managed-settings.json` (operator permissions), GitHub access via an org GitHub App (token helper, `gh` wrapper, `~/.gitconfig`) |
| `localai` | system user `localai` (home `/srv/localai`, GPU groups, subuid range, linger), pinned `local-ai` checkout, presets synced to `~/.config/llama-cpp`, unit templates and drop-ins, service instances, lab slot `llama-server@lab` (preset `lab/lab.ini`, port 8095, not started by default) |
| `timeshift` | excludes in `/etc/timeshift/timeshift.json` for data that is only pulled (models, container images, caches, git checkouts, the operator home). Snapshots land on the same disk; adds missing entries only, the owner's own entries and settings stay |

`claude-remote.service` is never restarted by Ansible (that would end the
operator's session); unit changes take effect at the next manual restart or
reboot. Not managed: `~aioperator/.kube/config` (holds a token; installed from
the Pulumi output `operatorKubeconfig`) and the operator's working checkouts.

## Bootstrap (once, as the owner)

```bash
sudo apt-get install -y ansible-core git
sudo git clone --depth 1 https://github.com/digitaleraluhut/homelab.git /var/lib/homelab-host/checkout
sudo bash /var/lib/homelab-host/checkout/host/bootstrap.sh
```

## Local checks

```bash
cd host
ansible-lint
ansible-playbook site.yml --syntax-check
ansible-playbook tests/render-sudoers.yml   # renders sudoers, validates with visudo
ansible-playbook tests/timeshift-excludes.yml   # timeshift role on a sample config
ansible-playbook tests/git-hooks.yml -e out=$(mktemp -d) -e ansible_become=false   # gitleaks + hook activation
```
