#!/usr/bin/env bash
# Restore test for Longhorn backups: proves that the latest backup of a volume
# can be read back. Run as cluster admin.
#
#   scripts/longhorn-restore-test.sh <source-volume> [--keep]
#
# <source-volume> is the Longhorn volume (= PV name) whose backups are tested,
# e.g. the PV of librechat/librechat-mongodb. The script
#   1. picks the newest Completed backup of that volume,
#   2. restores it into a new Longhorn volume "restore-test-<suffix>",
#   3. mounts it read-only in a pod in namespace "restore-test" and prints a
#      file listing, the disk usage and the newest files,
#   4. deletes pod, PVC, PV, volume and namespace again (unless --keep).
# The source volume and its workload are not touched.
set -euo pipefail

SRC="${1:?usage: $0 <source-volume> [--keep]}"
KEEP="${2:-}"
LH=longhorn-system
NS=restore-test
SUFFIX="$(date +%Y%m%d%H%M%S)"
VOL="restore-test-${SUFFIX}"

backup=$(kubectl -n "$LH" get backups.longhorn.io -l "backup-volume=${SRC}" \
  -o jsonpath='{range .items[?(@.status.state=="Completed")]}{.status.backupCreatedAt} {.metadata.name} {.status.url} {.status.volumeSize}{"\n"}{end}' |
  sort | tail -1)
[ -n "$backup" ] || { echo "No completed backup for ${SRC}" >&2; exit 1; }
read -r created name url size <<<"$backup"
echo "Restoring ${name} (created ${created}, $((size / 1024 / 1024)) MiB) of ${SRC} into ${VOL}"

cleanup() {
  [ "$KEEP" = "--keep" ] && { echo "Kept: namespace ${NS}, PV ${VOL}, volume ${VOL}"; return; }
  echo "Cleaning up"
  kubectl delete namespace "$NS" --ignore-not-found --wait=true >/dev/null
  kubectl delete pv "$VOL" --ignore-not-found --wait=true >/dev/null
  kubectl -n "$LH" delete volumes.longhorn.io "$VOL" --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT

kubectl apply -f - >/dev/null <<EOF
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: ${VOL}
  namespace: ${LH}
spec:
  fromBackup: "${url}"
  size: "${size}"
  numberOfReplicas: 1
  frontend: blockdev
  dataEngine: v1
EOF

echo -n "Waiting for the restore"
for _ in $(seq 1 360); do
  st=$(kubectl -n "$LH" get volumes.longhorn.io "$VOL" -o jsonpath='{.status.state} {.status.restoreRequired}' 2>/dev/null || true)
  [ "$st" = "detached false" ] && break
  echo -n "."; sleep 5
done
echo
[ "$st" = "detached false" ] || { echo "Restore did not finish (state: ${st})" >&2; exit 1; }

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${VOL}
spec:
  capacity:
    storage: "${size}"
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: ""
  claimRef:
    namespace: ${NS}
    name: data
  csi:
    driver: driver.longhorn.io
    fsType: ext4
    volumeHandle: ${VOL}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
  namespace: ${NS}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ""
  volumeName: ${VOL}
  resources:
    requests:
      storage: "${size}"
---
apiVersion: v1
kind: Pod
metadata:
  name: inspect
  namespace: ${NS}
spec:
  restartPolicy: Never
  containers:
    - name: inspect
      image: busybox:1.37
      command: ["sh", "-c"]
      args:
        - |
          echo "--- top level"; ls -la /data
          echo "--- usage"; du -sh /data
          echo "--- file count"; find /data -type f | wc -l
          echo "--- newest files"; find /data -type f -exec stat -c '%Y %y %n' {} + | sort -n | tail -5 | cut -d' ' -f2-
      volumeMounts:
        - name: data
          mountPath: /data
          readOnly: true
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: data
        readOnly: true
EOF

kubectl -n "$NS" wait pod/inspect --for=jsonpath='{.status.phase}'=Succeeded --timeout=300s >/dev/null ||
  { kubectl -n "$NS" describe pod inspect | tail -20; exit 1; }
kubectl -n "$NS" logs inspect
echo "Restore test of ${SRC} from ${name}: OK"
