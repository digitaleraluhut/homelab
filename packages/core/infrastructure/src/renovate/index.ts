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

export interface RenovateArgs {
  externalSecretsOperator: pulumi.Resource;
  storeName?: string;
  /** Repositories Renovate maintains. */
  repositories?: string[];
  /** Cron in the node's time zone. Default 02:30 every night. */
  schedule?: string;
  /** Pinned Renovate image tag; Renovate bumps its own pin via the custom manager in renovate.json. */
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
    { metadata: { name: NAMESPACE, labels: LABELS } },
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
                securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
                containers: [
                  {
                    name: "renovate",
                    // renovate-version: renovate/renovate
                    image: args.image ?? "renovate/renovate:41",
                    env: [
                      { name: "RENOVATE_PLATFORM", value: "github" },
                      { name: "RENOVATE_AUTODISCOVER", value: "false" },
                      { name: "RENOVATE_REPOSITORIES", value: repositories.join(",") },
                      // Unverified: built-in GitHub App auth of the Renovate CLI. If the
                      // CLI does not mint the installation token itself, add an init
                      // container that does (see docs/howto/setup-renovate.md).
                      secretEnv("RENOVATE_GITHUB_APP_ID", "app_id"),
                      secretEnv("RENOVATE_GITHUB_APP_KEY", "private_key"),
                      secretEnv("RENOVATE_GITHUB_APP_INSTALLATION_ID", "installation_id"),
                      { name: "LOG_LEVEL", value: "info" },
                    ],
                    securityContext: {
                      allowPrivilegeEscalation: false,
                      capabilities: { drop: ["ALL"] },
                    },
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
    { ...opts, dependsOn: [ns, secret] }
  );

  return { namespace: ns, secret, cronJob };
}
