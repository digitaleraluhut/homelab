# Managed by Ansible (homelab host/roles/k3s-kubectl).
# /usr/local/bin/kubectl is the k3s binary, which reads the root-only server
# config /etc/rancher/k3s/config.yaml on every call and warns "permission
# denied" for every other user. kubectl does not need that file. Root keeps it,
# because other k3s subcommands do.
if [ "$(id -u)" != 0 ]; then
  export K3S_CONFIG_FILE=/dev/null
fi
