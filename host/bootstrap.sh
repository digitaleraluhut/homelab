#!/bin/bash
# One-time bootstrap on the host, run by the owner as root:
#   sudo apt-get install -y ansible-core git
#   sudo git clone --depth 1 https://github.com/digitaleraluhut/homelab.git /var/lib/homelab-host/checkout
#   sudo bash /var/lib/homelab-host/checkout/host/bootstrap.sh
# Installs only the runner; everything else follows from host/mode on main.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo bash $0)" >&2; exit 1; }
cd "$(dirname "$(readlink -f "$0")")"
export ANSIBLE_CONFIG=$PWD/ansible.cfg
ansible-playbook site.yml --tags runner
systemctl start --no-block homelab-host-apply.service
echo "Runner installed. Follow the first run: journalctl -fu homelab-host-apply"
