#!/usr/bin/env bash

set -euo pipefail

CONTEXT="flinker"
LONGHORN_NAMESPACE="longhorn-system"

usage() {
  cat <<'EOF'
Usage: analyze-longhorn-storage.sh [--context CONTEXT]

Read-only report of Longhorn volumes, Kubernetes PVC/PV bindings, backup state,
and the configured Longhorn R2 backup target.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      CONTEXT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

command -v kubectl >/dev/null || { printf 'error: kubectl is required\n' >&2; exit 1; }
command -v jq >/dev/null || { printf 'error: jq is required\n' >&2; exit 1; }

KUBECTL=(kubectl --context "$CONTEXT")
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

"${KUBECTL[@]}" -n "$LONGHORN_NAMESPACE" get volumes.longhorn.io -o json >"$TMP_DIR/volumes.json"
"${KUBECTL[@]}" get pvc -A -o json >"$TMP_DIR/pvcs.json"
"${KUBECTL[@]}" get pv -o json >"$TMP_DIR/pvs.json"
"${KUBECTL[@]}" -n "$LONGHORN_NAMESPACE" get backups.longhorn.io -o json >"$TMP_DIR/backups.json"
"${KUBECTL[@]}" -n "$LONGHORN_NAMESPACE" get backupvolumes.longhorn.io -o json >"$TMP_DIR/backupvolumes.json"
"${KUBECTL[@]}" -n "$LONGHORN_NAMESPACE" get backuptargets.longhorn.io default -o json >"$TMP_DIR/backuptarget.json"
"${KUBECTL[@]}" -n "$LONGHORN_NAMESPACE" get setting.longhorn.io auto-cleanup-when-delete-backup -o json >"$TMP_DIR/cleanup-setting.json"

printf '\nLonghorn R2 status (%s)\n' "$CONTEXT"
jq -r '
  "  target: " + (.spec.backupTargetURL // "<unset>") +
  "\n  available: " + ((.status.available // false)|tostring) +
  "\n  last synced: " + (.status.lastSyncedAt // "<never>")
' "$TMP_DIR/backuptarget.json"
printf '  delete cleanup: '
jq -r '.value // "<unset>"' "$TMP_DIR/cleanup-setting.json"
printf '  credential secret: longhorn-backup-secret (values not displayed)\n'

printf '\nLonghorn volume report\n'
printf '%-38s %-10s %-10s %-10s %-10s %-18s %-28s %-8s %-12s %-20s\n' \
  'VOLUME' 'ALLOCATED' 'ACTUAL' 'STATE' 'ROBUST' 'CURRENT PVC' 'HISTORICAL WORKLOAD' 'BACKUPS' 'BACKUP DATA' 'LAST BACKUP'

jq -r --slurpfile pvcs "$TMP_DIR/pvcs.json" \
  --slurpfile pvs "$TMP_DIR/pvs.json" \
  --slurpfile backups "$TMP_DIR/backups.json" \
  --slurpfile backupvolumes "$TMP_DIR/backupvolumes.json" '
  def mib($n): (($n // 0) / 1048576 | floor);
  def gib($n): (($n // 0) / 1073741824 * 100 | floor / 100);
  def current_pvc($name): [
    $pvcs[0].items[] |
    select(.spec.volumeName == $name) |
    [.metadata.namespace, .metadata.name, .status.phase] | join("/")
  ][0] // "-";
  def backup_list($name): [
    $backups[0].items[] | select(.metadata.labels["backup-volume"] == $name)
  ];
  def backup_volume($name): [
    $backupvolumes[0].items[] | select(.metadata.name == $name)
  ][0];
  .items[] |
  . as $volume |
  (backup_list(.metadata.name)) as $backups_for_volume |
  (backup_volume(.metadata.name)) as $backup_volume |
  [
    .metadata.name,
    (gib((.spec.size // "0")|tonumber) | tostring + "Gi"),
    (gib(.status.actualSize) | tostring + "Gi"),
    (.status.state // "-"),
    (.status.robustness // "-"),
    (current_pvc(.metadata.name)),
    ((.status.kubernetesStatus.workloadsStatus[0].workloadName // .status.kubernetesStatus.pvcName // "-")|tostring),
    ($backups_for_volume|length|tostring),
    (if $backup_volume then (gib(($backup_volume.status.dataStored // "0")|tonumber)|tostring + "Gi") else "-" end),
    ($backup_volume.status.lastBackupAt // "-")
  ] | @tsv
' "$TMP_DIR/volumes.json" | column -t -s $'\t'

printf '\nBackup inventories with application references\n'
printf '  %-38s %-12s %-10s %-10s %-22s %s\n' \
  'VOLUME' 'STORAGE CLASS' 'SIZE' 'STORED' 'LAST BACKUP' 'APPLICATION/PVC'
jq -r '
  def human($n):
    (($n // "0") | tonumber) as $bytes |
    if $bytes >= 1073741824 then (($bytes / 1073741824 * 100 | floor) / 100 | tostring) + "Gi"
    elif $bytes >= 1048576 then (($bytes / 1048576 * 100 | floor) / 100 | tostring) + "Mi"
    elif $bytes >= 1024 then (($bytes / 1024 * 100 | floor) / 100 | tostring) + "Ki"
    else ($bytes|tostring) + "B" end;
  .items[] |
  (.status.labels.KubernetesStatus // "{}" | fromjson? // {}) as $k |
  [
    .metadata.name,
    (if (.status.storageClassName // "") == "" then "-" else .status.storageClassName end),
    human(.status.size),
    human(.status.dataStored),
    (.status.lastBackupAt // "-"),
    (($k.namespace // "-") + "/" + ($k.pvcName // "-"))
  ] | @tsv
' "$TMP_DIR/backupvolumes.json" | while IFS=$'\t' read -r volume storage_class size data_stored last_backup application; do
  printf '  %-38s %-20s %-10s %-10s %-22s %s\n' \
    "$volume" "$storage_class" "$size" "$data_stored" "$last_backup" "$application"
done

printf '\nNotes\n'
