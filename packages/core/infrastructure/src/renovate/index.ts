import * as fs from "node:fs";
import * as path from "node:path";
import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Self-hosted Renovate (issue #100): a nightly CronJob with its own GitHub App.
 *
 * - The App credentials (app id, installation id, private key) come from Pulumi ESC through
 *   an ExternalSecret. Keys in ESC: renovate-app-id, renovate-installation-id,
 *   renovate-app-private-key. The App itself is created by the owner (see
 *   docs/howto/setup-renovate.md); until the ESC keys exist the ExternalSecret stays
 *   pending and the job fails harmlessly.
 * - Renovate needs a GitHub App installation token and does not mint it itself
 *   (https://docs.renovatebot.com/modules/platform/github/#running-as-a-github-app). The init
 *   container mint-token (mint-token.mjs) mints one per run and writes only the token to an
 *   in-memory volume; Renovate reads it through its global config file (config.js). The App
 *   secret is mounted into the init container only.
 * - Renovate's behaviour (schedule of PRs, grouping, release-age windows, auto-merge rules)
 *   lives in renovate.json in each repository, not here. This only runs the bot.
 *
 * Schedule and resource limits are proposals (not owner-set), except "daily at night".
 */

const NAMESPACE = "renovate";
const SECRET_NAME = "renovate-github-app";
const LABELS = {
  "app.kubernetes.io/managed-by": "pulumi-homelab",
  "app.kubernetes.io/part-of": "renovate",
};
// The bot user of the App `digitaleraluhut-renovate` (docs/howto/setup-renovate.md).
const APP_USERNAME = "digitaleraluhut-renovate[bot]";
// One image for both containers: the init container needs only Node, which this image has.
// renovate: image
const IMAGE =
  "renovate/renovate:41.173.1@sha256:e998e1218fe572e23278d8808186a310784f7cb2ac8055307183ffc51d3a59e5";
// The image's own non-root user (containerbase `ubuntu`); its HOME belongs to it.
const IMAGE_UID = 12021;
const TOKEN_DIR = "/run/renovate-token";
const SCRIPTS_INIT_DIR = "/opt/renovate-token";
const CONFIG_DIR = "/etc/renovate";
const readScript = (file: string) => fs.readFileSync(path.join(__dirname, file), "utf8");

export interface RenovateArgs {
  externalSecretsOperator: pulumi.Resource;
  storeName?: string;
  /** Repositories Renovate maintains. */
  repositories?: string[];
  /** Cron in the node's time zone. Default 02:30 every night. */
  schedule?: string;
  /** Renovate image (tag@digest); Renovate bumps the default via the custom manager in renovate.json. */
  image?: string;
}

export function createRenovate(args: RenovateArgs, opts?: pulumi.ResourceOptions) {
  const storeName = args.storeName ?? "pulumi-esc";
  const repositories = args.repositories ?? [
    "digitaleraluhut/homelab",
    "digitaleraluhut/homelab-apps",
    "digitaleraluhut/local-ai",
    "digitaleraluhut/homelab-wiki",
  ];

  const ns = new k8s.core.v1.Namespace(
    "renovate-ns",
    {
      metadata: {
        name: NAMESPACE,
        labels: {
          ...LABELS,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
      },
    },
    opts
  );

  const secret = new k8s.apiextensions.CustomResource(
    "renovate-github-app",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: SECRET_NAME, namespace: NAMESPACE, labels: LABELS },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: storeName, kind: "ClusterSecretStore" },
        target: { name: SECRET_NAME, creationPolicy: "Owner" },
        data: [
          { secretKey: "app_id", remoteRef: { key: "renovate-app-id" } },
          { secretKey: "installation_id", remoteRef: { key: "renovate-installation-id" } },
          { secretKey: "private_key", remoteRef: { key: "renovate-app-private-key" } },
        ],
      },
    },
    { ...opts, dependsOn: [ns, args.externalSecretsOperator] }
  );

  const secretEnv = (name: string, key: string) => ({
    name,
    valueFrom: { secretKeyRef: { name: SECRET_NAME, key } },
  });

  const scripts = new k8s.core.v1.ConfigMap(
    "renovate-scripts",
    {
      metadata: { name: "renovate-scripts", namespace: NAMESPACE, labels: LABELS },
      data: {
        "mint-token.mjs": readScript("mint-token.mjs"),
        "config.js": readScript("config.js"),
      },
    },
    { ...opts, dependsOn: [ns] }
  );

  const image = args.image ?? IMAGE;
  const restricted = {
    allowPrivilegeEscalation: false,
    privileged: false,
    capabilities: { drop: ["ALL"] },
  };

  const cronJob = new k8s.batch.v1.CronJob(
    "renovate",
    {
      metadata: { name: "renovate", namespace: NAMESPACE, labels: LABELS },
      spec: {
        schedule: args.schedule ?? "30 2 * * *",
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: 3600,
            template: {
              spec: {
                restartPolicy: "Never",
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: IMAGE_UID,
                  seccompProfile: { type: "RuntimeDefault" },
                },
                volumes: [
                  { name: "token", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
                  { name: "scripts", configMap: { name: "renovate-scripts", defaultMode: 0o444 } },
                ],
                initContainers: [
                  {
                    name: "mint-token",
                    image,
                    command: ["node", `${SCRIPTS_INIT_DIR}/mint-token.mjs`],
                    env: [
                      secretEnv("GITHUB_APP_ID", "app_id"),
                      secretEnv("GITHUB_APP_INSTALLATION_ID", "installation_id"),
                      secretEnv("GITHUB_APP_PRIVATE_KEY", "private_key"),
                      {
                        name: "GITHUB_REPOSITORIES",
                        value: repositories.map((r) => r.split("/").pop()).join(","),
                      },
                      { name: "TOKEN_FILE", value: `${TOKEN_DIR}/token` },
                    ],
                    volumeMounts: [
                      { name: "token", mountPath: TOKEN_DIR },
                      { name: "scripts", mountPath: SCRIPTS_INIT_DIR, readOnly: true },
                    ],
                    securityContext: { ...restricted, readOnlyRootFilesystem: true },
                    resources: {
                      requests: { cpu: "10m", memory: "64Mi" },
                      limits: { memory: "128Mi" },
                    },
                  },
                ],
                containers: [
                  {
                    name: "renovate",
                    image,
                    env: [
                      { name: "RENOVATE_PLATFORM", value: "github" },
                      { name: "RENOVATE_AUTODISCOVER", value: "false" },
                      { name: "RENOVATE_REPOSITORIES", value: repositories.join(",") },
                      { name: "RENOVATE_USERNAME", value: APP_USERNAME },
                      // config.js sets `token` from the file the init container wrote.
                      { name: "RENOVATE_CONFIG_FILE", value: `${CONFIG_DIR}/config.js` },
                      { name: "RENOVATE_TOKEN_FILE", value: `${TOKEN_DIR}/token` },
                      { name: "LOG_LEVEL", value: "info" },
                    ],
                    volumeMounts: [
                      { name: "token", mountPath: TOKEN_DIR, readOnly: true },
                      { name: "scripts", mountPath: CONFIG_DIR, readOnly: true },
                    ],
                    // Root filesystem stays writable: Renovate and containerbase write caches
                    // and tools below HOME and /tmp. Not required by the restricted profile.
                    securityContext: { ...restricted, readOnlyRootFilesystem: false },
                    resources: {
                      requests: { cpu: "100m", memory: "512Mi" },
                      limits: { memory: "2Gi" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
    { ...opts, dependsOn: [ns, secret, scripts] }
  );

  return { namespace: ns, secret, scripts, cronJob };
}
