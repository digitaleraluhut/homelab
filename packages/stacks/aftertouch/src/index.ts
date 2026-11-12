/**
 * @mrsimpson/homelab-aftertouch
 *
 * AfterTouch: local cloud replacement for Bose SoundTouch speakers. A privileged workload
 * (hostPorts on the LAN), so it lives in the owner-reviewed homelab stack and not in
 * homelab-apps, whose CI may only create pod-security "restricted" namespaces.
 *
 * Moved from homelab-apps (apps/aftertouch, stack mrsimpson/aftertouch/dev) on 2026-11-11.
 * Resource names are unchanged, so `pulumi state move` carries the existing resources
 * (including the data volume) over without replacing them.
 *
 * Config (homelab stack, prefix "aftertouch:"): nodeIp, nodeName, mgmtUsername (secret),
 * mgmtPassword (secret); optional discoverySubnets (LAN CIDRs, comma-separated), appHostname. The image versions are pinned
 * here, not in config, so an update is a reviewed diff.
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "aftertouch";
// Before raising a version, read the upstream release notes in between for breaking changes
// (https://github.com/gesellix/Bose-SoundTouch/releases) and snapshot the volume aftertouch-data.
const APP_IMAGE = "ghcr.io/gesellix/bose-soundtouch:0.139.0";
const WEB_IMAGE = "ghcr.io/gesellix/bose-soundtouch-web:0.114.0";
const NAMESPACE = APP_NAME;
const APP_PORT = 8000; // HTTP web UI + speaker API (AfterTouch backend)
const HTTPS_PORT = 8443; // HTTPS for speaker DNS redirect method
const WEB_PORT = 9090; // soundtouch-web UI (sidecar) — 8080 taken by llama.cpp on host
// The image's unprivileged user (it defaults to root, but ships this user for non-root use).
const APP_UID = 65532;

// LAN access: Fritz.Box DNS entry required → <appHostname> → <nodeIp>
// NodePort services expose the app directly on the node for local network access.
// No Cloudflare Tunnel or Traefik IngressRoute is used — this is a local-only app.
const NODE_PORT_HTTP = 30800;
const NODE_PORT_HTTPS = 30843;
const NODE_PORT_WEB = 30909;

export function setupAftertouch() {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const cfg = new pulumi.Config("aftertouch");
  const mgmtUsername = cfg.requireSecret("mgmtUsername");
  const mgmtPassword = cfg.requireSecret("mgmtPassword");
  const discoverySubnets = cfg.get("discoverySubnets");
  const nodeIp = cfg.require("nodeIp");
  const nodeName = cfg.require("nodeName");
  const APP_HOSTNAME = cfg.get("appHostname") ?? `aftertouch.${nodeName}.fritz.box`;

  // ---------------------------------------------------------------------------
  // 1. Namespace
  // ---------------------------------------------------------------------------

  const ns = new k8s.core.v1.Namespace(`${APP_NAME}-ns`, {
    metadata: {
      name: NAMESPACE,
      labels: {
        app: APP_NAME,
        // hostPort is refused by "baseline", so enforcement stays privileged; warn and audit
        // report anything beyond that.
        "pod-security.kubernetes.io/enforce": "privileged",
        "pod-security.kubernetes.io/warn": "baseline",
        "pod-security.kubernetes.io/audit": "baseline",
      },
    },
  });

  // ---------------------------------------------------------------------------
  // 2. Secret — management credentials injected via envFrom
  // ---------------------------------------------------------------------------

  const mgmtSecret = new k8s.core.v1.Secret(
    `${APP_NAME}-mgmt`,
    {
      metadata: {
        name: `${APP_NAME}-mgmt`,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      type: "Opaque",
      stringData: {
        MGMT_USERNAME: mgmtUsername,
        MGMT_PASSWORD: mgmtPassword,
      },
    },
    { dependsOn: [ns] }
  );

  // ---------------------------------------------------------------------------
  // 3. PersistentVolumeClaim — app data at /app/data
  // ---------------------------------------------------------------------------

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    `${APP_NAME}-pvc`,
    {
      metadata: {
        name: `${APP_NAME}-data`,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "longhorn-uncritical",
        resources: { requests: { storage: "500Mi" } },
      },
    },
    { dependsOn: [ns] }
  );

  // ---------------------------------------------------------------------------
  // 4. Deployment
  //
  // On the pod network, with hostPorts. The speakers were migrated to <node>:8000 and :8443;
  // another port would mean re-migrating every speaker. A hostPort keeps those addresses and,
  // unlike a NodePort, the speaker's source IP, which the server uses to push credentials
  // back to the speaker. The pod is pinned to the node whose IP the speakers know.
  //
  // Multicast discovery (SSDP/mDNS) does not reach the LAN from here. The server finds
  // speakers by a unicast scan (GET <ip>:8090/info) of DISCOVERY_SUBNETS instead, on
  // "Scan Again" and hourly; without the subnets it would guess from its own pod network.
  // ---------------------------------------------------------------------------

  const env: k8s.types.input.core.v1.EnvVar[] = [
    { name: "BASE_URL", value: `http://${APP_HOSTNAME}` },
    ...(discoverySubnets
      ? [
          { name: "DISCOVERY_SUBNETS", value: discoverySubnets },
          { name: "DISCOVERY_SCAN_INTERVAL", value: "1h" },
        ]
      : []),
  ];

  const deployment = new k8s.apps.v1.Deployment(
    `${APP_NAME}-deployment`,
    {
      metadata: {
        name: APP_NAME,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        replicas: 1,
        // Recreate (not RollingUpdate): two pods cannot hold the same host ports on the node,
        // so the old pod must terminate before the new one can start.
        strategy: { type: "Recreate", rollingUpdate: undefined },
        selector: { matchLabels: { app: APP_NAME } },
        template: {
          metadata: { labels: { app: APP_NAME } },
          spec: {
            nodeSelector: { "kubernetes.io/hostname": nodeName },
            // The server puts os.Hostname() into its TLS certificate and expected hosts. Under
            // hostNetwork that was the node's name; keep it, or each new pod regenerates the cert.
            hostname: nodeName,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: APP_UID,
              runAsGroup: APP_UID,
              // The volume was written by root; fsGroup makes it writable for APP_UID.
              fsGroup: APP_UID,
              fsGroupChangePolicy: "OnRootMismatch",
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "app",
                image: APP_IMAGE,
                ports: [
                  { name: "http", containerPort: APP_PORT, hostPort: APP_PORT },
                  { name: "https", containerPort: HTTPS_PORT, hostPort: HTTPS_PORT },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  // The binary carries the file capability cap_net_bind_service=+ep; without it
                  // in the bounding set exec fails with EPERM.
                  capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
                },
                env,
                envFrom: [{ secretRef: { name: `${APP_NAME}-mgmt` } }],
                resources: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                volumeMounts: [{ name: "data", mountPath: "/app/data" }],
                readinessProbe: {
                  httpGet: { path: "/", port: APP_PORT },
                  initialDelaySeconds: 15,
                  periodSeconds: 15,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: APP_PORT },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  failureThreshold: 3,
                },
              },
              // soundtouch-web UI sidecar — SPA frontend that talks to the AfterTouch
              // backend on localhost:8000 (the pod's shared network namespace).
              {
                name: "web",
                image: WEB_IMAGE,
                // Default port is 8080 which is taken by llama.cpp on this host.
                // Override via the -port flag to use 9090 instead.
                args: ["-port", `${WEB_PORT}`],
                ports: [{ name: "web", containerPort: WEB_PORT, hostPort: WEB_PORT }],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "20m", memory: "32Mi" },
                  limits: { cpu: "200m", memory: "128Mi" },
                },
                readinessProbe: {
                  httpGet: { path: "/", port: WEB_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  failureThreshold: 3,
                },
              },
            ],
            volumes: [
              {
                name: "data",
                persistentVolumeClaim: { claimName: `${APP_NAME}-data` },
              },
            ],
          },
        },
      },
    },
    { dependsOn: [ns, pvc, mgmtSecret] }
  );

  // ---------------------------------------------------------------------------
  // 5. Services
  //
  // ClusterIP — stable in-cluster DNS name: aftertouch.aftertouch.svc.cluster.local
  //   Used by other pods that want to reach the AfterTouch API.
  //
  // NodePort (HTTP + HTTPS) — direct LAN access on the node's IP.
  //   Fritz.Box DNS: <appHostname> → <nodeIp>
  //   Web UI:  http://<appHostname>:30800  (or port-redirect 80→30800)
  //   Speakers: https://<appHostname>:30843 (TLS redirect method)
  // ---------------------------------------------------------------------------

  // ClusterIP — in-cluster service discovery
  new k8s.core.v1.Service(
    `${APP_NAME}-svc`,
    {
      metadata: {
        name: APP_NAME,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        type: "ClusterIP",
        selector: { app: APP_NAME },
        ports: [
          { name: "http", port: APP_PORT, targetPort: APP_PORT, protocol: "TCP" },
          { name: "https", port: HTTPS_PORT, targetPort: HTTPS_PORT, protocol: "TCP" },
          { name: "web", port: WEB_PORT, targetPort: WEB_PORT, protocol: "TCP" },
        ],
      },
    },
    { dependsOn: [deployment] }
  );

  // NodePort — HTTP web UI, LAN access
  new k8s.core.v1.Service(
    `${APP_NAME}-http`,
    {
      metadata: {
        name: `${APP_NAME}-http`,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        type: "NodePort",
        selector: { app: APP_NAME },
        ports: [
          {
            name: "http",
            port: APP_PORT,
            targetPort: APP_PORT,
            protocol: "TCP",
            nodePort: NODE_PORT_HTTP,
          },
        ],
      },
    },
    { dependsOn: [deployment] }
  );

  // NodePort — HTTPS, for speaker DNS redirect method
  new k8s.core.v1.Service(
    `${APP_NAME}-https`,
    {
      metadata: {
        name: `${APP_NAME}-https`,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        type: "NodePort",
        selector: { app: APP_NAME },
        ports: [
          {
            name: "https",
            port: HTTPS_PORT,
            targetPort: HTTPS_PORT,
            protocol: "TCP",
            nodePort: NODE_PORT_HTTPS,
          },
        ],
      },
    },
    { dependsOn: [deployment] }
  );

  // NodePort — soundtouch-web UI
  new k8s.core.v1.Service(
    `${APP_NAME}-web`,
    {
      metadata: {
        name: `${APP_NAME}-web`,
        namespace: NAMESPACE,
        labels: { app: APP_NAME },
      },
      spec: {
        type: "NodePort",
        selector: { app: APP_NAME },
        ports: [
          {
            name: "web",
            port: WEB_PORT,
            targetPort: WEB_PORT,
            protocol: "TCP",
            nodePort: NODE_PORT_WEB,
          },
        ],
      },
    },
    { dependsOn: [deployment] }
  );

  // ---------------------------------------------------------------------------
  // Stack outputs
  // ---------------------------------------------------------------------------

  return {
    url: `http://${APP_HOSTNAME}:${NODE_PORT_HTTP}`,
    webUiUrl: `http://${nodeIp}:${NODE_PORT_WEB}`,
    directHttpUrl: `http://${nodeIp}:${NODE_PORT_HTTP}`,
    directHttpsUrl: `https://${nodeIp}:${NODE_PORT_HTTPS}`,
    inClusterUrl: `http://${APP_NAME}.${NAMESPACE}.svc.cluster.local:${APP_PORT}`,
    lanNote: `Fritz.Box DNS required: ${APP_HOSTNAME} → ${nodeIp}`,
    namespace: ns.metadata.name,
  };
}
