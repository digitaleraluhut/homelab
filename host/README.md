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
| `aioperator` | user `aioperator`, its sudo whitelist (validated with `visudo`), `claude-remote.service`, workspace instructions (`AGENTS.md`, `CLAUDE.md` link), agent skills (skills-coding checkout linked; this repo's `skills/` copied from main), Claude Code managed settings `/etc/claude-code/managed-settings.json` (operator permissions), GitHub access via an org GitHub App (token helper, `gh` wrapper, `~/.gitconfig`) |
| `sysctl` | kernel settings in `/etc/sysctl.d/60-homelab.conf` (inotify limits for a Kubernetes node), applied with `sysctl --load` on change |
| `k3s_kubectl` | `/etc/profile.d/k3s-kubectl.sh`: `K3S_CONFIG_FILE=/dev/null` for non-root users, so `kubectl` (the k3s binary) stops warning about the root-only `/etc/rancher/k3s/config.yaml` |
| `walle` | the apprentice agent WALL-E: system user `walle` (no login, no sudo), shared tree `/srv/walle` (`app`, `repos`, `inbox` written only by the operator; `work`, `outbox` by WALL-E; group `walle` includes the operator), `walle.service` (host program from `/srv/walle/app`, network only to localhost, read-only system), `walle-review.path`/`.service` (a pending request starts the operator's headless review), `walle-mirrors.timer` (hourly, as the operator: mirrors in `/srv/walle/repos`, always on). Both units are installed but switched off until `walle_enabled` / `walle_review_enabled` |
| `localai` | model sync (`localai-model-sync`, catalog `models/catalog.yaml` of local-ai: downloads missing files, verifies sha256, never deletes; after each ref change and daily), system user `localai` (home `/srv/localai`, GPU groups, subuid range, linger), pinned `local-ai` checkout, presets synced to `~/.config/llama-cpp`, unit templates and drop-ins, service instances, lab slot `llama-server@lab` (preset `lab/lab.ini`, port 8095, not started by default) |
| `timeshift` | excludes in `/etc/timeshift/timeshift.json` for data that is only pulled (models, container images, caches, git checkouts, the operator home). Snapshots land on the same disk; adds missing entries only, the owner's own entries and settings stay |

`claude-remote.service` reattaches to the last session on start (`--continue`, with a new session only when there is none to continue) and is never restarted by Ansible (that would end the
operator's session); unit changes take effect at the next manual restart or
reboot. Not managed: `~aioperator/.kube/config` and `/etc/homelab/walle/kubeconfig`
(hold tokens; installed from the Pulumi outputs `operatorKubeconfig` and `walleKubeconfig`) and the operator's working checkouts.

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
ansible-playbook tests/repo-skills.yml -e out=$(mktemp -d)   # skills copied from skills/
ansible-playbook tests/git-hooks.yml -e out=$(mktemp -d) -e ansible_become=false   # gitleaks + hook activation
ansible-playbook tests/github-app.yml -e out=$(mktemp -d)   # GitHub App helpers, git identity
ansible-playbook tests/workspace-agents.yml -e out=$(mktemp -d)   # AGENTS.md + CLAUDE.md link
ansible-playbook tests/walle.yml -e out=$(mktemp -d)   # WALL-E units and git configs, fences checked
```

Every new `copy` or `template` task must be **executed** in a test playbook
before the PR (render into a temp dir). Lint and syntax checks do not catch
undefined variables such as `ansible_managed` in `copy` content.
