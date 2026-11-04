import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * CI access for the homelab-apps repository: a ServiceAccount with exactly the
 * rights the app stacks need, plus a kubeconfig for it as a secret stack output.
 *
 * Replaces the ad-hoc setup from scripts/create-kubeconfig.sh (ServiceAccount
 * ci/homelab-apps + ClusterRole homelab-ci-deployer), which granted pods/exec,
 * deployments etc. cluster-wide and namespace deletion for every namespace.
 *
 * Scope:
 * - Full namespaced rights (incl. secrets and Roles) only inside the app namespaces.
 * - Namespaces: create any, but update/patch/delete only the app namespaces.
 * - observability: the opencode dashboard ConfigMap + its sync Job.
 * - No cluster-scoped writes otherwise, no pods/exec or port-forward anywhere.
 *
 * Adding an app: add its namespace to `appNamespaces` (reviewed via CODEOWNERS),
 * deploy homelab, then deploy the app. RoleBindings need the namespace to exist,
 * so a new app's namespace is created here and the app must not create it itself.
 *
 * Get the kubeconfig for the GitHub environment secret:
 *   pulumi stack output ciAppsKubeconfig --show-secrets | base64 | tr -d '\n'
 */

export interface CiAccessArgs {
  /** Namespaces the homelab-apps CI may deploy into. */
  appNamespaces: string[];
  /** Namespaces that already exist (created by the app stacks themselves). */
  existingNamespaces: string[];
  /** API server URL reachable from CI runners (Tailscale address of the node). */
  apiServer: string;
}

const NAMESPACE = "ci-access";
const SA_NAME = "homelab-apps";
const ALL = ["get", "list", "watch", "create", "update", "patch", "delete"];
const LABELS = {
  "app.kubernetes.io/managed-by": "pulumi-homelab",
  "app.kubernetes.io/part-of": "ci-access",
};

/** Namespaced rights an app stack needs; bound per app namespace via RoleBinding. */
const appDeployerRules: k8s.types.input.rbac.v1.PolicyRule[] = [
  {
    apiGroups: [""],
    resources: [
      "pods",
      "pods/log",
      "services",
      "endpoints",
      "configmaps",
      "secrets",
      "persistentvolumeclaims",
      "serviceaccounts",
      "events",
    ],
    verbs: ALL,
  },
  {
    apiGroups: ["apps"],
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"],
    verbs: ALL,
  },
  { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ALL },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies"], verbs: ALL },
  { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: ALL },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: ALL },
  // Apps may create Roles for their own workloads (e.g. the opencode cloudflare
  // operator). RBAC escalation checks still apply: a Role can only grant what
  // this ServiceAccount already holds in that namespace.
  { apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles", "rolebindings"], verbs: ALL },
  { apiGroups: ["traefik.io", "traefik.containo.us"], resources: ["*"], verbs: ALL },
  { apiGroups: ["postgresql.cnpg.io"], resources: ["*"], verbs: ALL },
  {
    apiGroups: ["external-secrets.io"],
    resources: ["externalsecrets", "secretstores"],
    verbs: ALL,
  },
  { apiGroups: ["gateway.networking.k8s.io"], resources: ["httproutes", "grpcroutes"], verbs: ALL },
];

export function createCiAccess(args: CiAccessArgs) {
  const missing = args.appNamespaces.filter((n) => !args.existingNamespaces.includes(n));

  const ns = new k8s.core.v1.Namespace("ci-access-ns", {
    metadata: {
      name: NAMESPACE,
      labels: { ...LABELS, "pod-security.kubernetes.io/enforce": "restricted" },
    },
  });

  // Namespaces of new apps are owned here, so RoleBindings can be created before
  // the first app deploy.
  const createdNamespaces = missing.map(
    (name) =>
      new k8s.core.v1.Namespace(`ci-app-ns-${name}`, {
        metadata: {
          name,
          labels: {
            ...LABELS,
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/audit": "restricted",
            "pod-security.kubernetes.io/warn": "restricted",
          },
        },
      })
  );

  const sa = new k8s.core.v1.ServiceAccount("ci-homelab-apps-sa", {
    metadata: { name: SA_NAME, namespace: ns.metadata.name, labels: LABELS },
  });
  const subject = { kind: "ServiceAccount", name: SA_NAME, namespace: NAMESPACE };

  const nsRole = new k8s.rbac.v1.ClusterRole("ci-homelab-apps-namespaces", {
    metadata: { name: "ci-access:homelab-apps:namespaces", labels: LABELS },
    rules: [
      // `create` cannot be limited by name; new namespaces carry no rights for CI.
      { apiGroups: [""], resources: ["namespaces"], verbs: ["get", "list", "watch", "create"] },
      {
        apiGroups: [""],
        resources: ["namespaces"],
        resourceNames: args.appNamespaces,
        verbs: ["update", "patch", "delete"],
      },
    ],
  });
  new k8s.rbac.v1.ClusterRoleBinding("ci-homelab-apps-namespaces", {
    metadata: { name: "ci-access:homelab-apps:namespaces", labels: LABELS },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: nsRole.metadata.name,
    },
    subjects: [subject],
  });

  const deployerRole = new k8s.rbac.v1.ClusterRole("ci-homelab-apps-deployer", {
    metadata: { name: "ci-access:homelab-apps:deployer", labels: LABELS },
    rules: appDeployerRules,
  });

  for (const name of args.appNamespaces) {
    new k8s.rbac.v1.RoleBinding(
      `ci-homelab-apps-deployer-${name}`,
      {
        metadata: { name: "ci-access:homelab-apps:deployer", namespace: name, labels: LABELS },
        // ClusterRole bound via RoleBinding: the rules apply only in this namespace.
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: deployerRole.metadata.name,
        },
        subjects: [subject],
      },
      { dependsOn: createdNamespaces }
    );
  }

  // apps/opencode-router writes a Grafana dashboard ConfigMap and a sync Job into
  // observability. Job names are timestamped, so only the ConfigMap is name-limited.
  // Follow-up: provision dashboards from app namespaces via Grafana's sidecar instead.
  const obsRole = new k8s.rbac.v1.Role("ci-homelab-apps-observability", {
    metadata: {
      name: "ci-access:homelab-apps:dashboards",
      namespace: "observability",
      labels: LABELS,
    },
    rules: [
      { apiGroups: [""], resources: ["configmaps"], verbs: ["create"] },
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: ["opencode-dashboards"],
        verbs: ["get", "list", "watch", "update", "patch", "delete"],
      },
      {
        apiGroups: ["batch"],
        resources: ["jobs"],
        verbs: ["get", "list", "watch", "create", "delete"],
      },
      { apiGroups: [""], resources: ["pods", "pods/log"], verbs: ["get", "list", "watch"] },
    ],
  });
  new k8s.rbac.v1.RoleBinding("ci-homelab-apps-observability", {
    metadata: {
      name: "ci-access:homelab-apps:dashboards",
      namespace: "observability",
      labels: LABELS,
    },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: obsRole.metadata.name },
    subjects: [subject],
  });

  // Long-lived token (CI cannot request short-lived tokens without cluster access).
  const tokenSecret = new k8s.core.v1.Secret(
    "ci-homelab-apps-token",
    {
      metadata: {
        name: `${SA_NAME}-token`,
        namespace: NAMESPACE,
        labels: LABELS,
        annotations: { "kubernetes.io/service-account.name": SA_NAME },
      },
      type: "kubernetes.io/service-account-token",
    },
    { dependsOn: [sa] }
  );

  // The token controller fills in token/ca.crt after creation, so read it back.
  const token = k8s.core.v1.Secret.get(
    "ci-homelab-apps-token-read",
    pulumi.interpolate`${NAMESPACE}/${tokenSecret.metadata.name}`,
    {
      dependsOn: [tokenSecret],
    }
  );

  const kubeconfig = pulumi
    .all([token.data, pulumi.output(args.apiServer)])
    .apply(([data, server]) => renderKubeconfig(data, server));

  return { serviceAccount: sa, kubeconfig: pulumi.secret(kubeconfig) };
}

/** Builds the kubeconfig from the token Secret's data (values base64-encoded). */
export function renderKubeconfig(data: Record<string, string> | undefined, server: string): string {
  if (!data?.token || !data?.["ca.crt"]) {
    return "token not populated yet - run the deploy once more";
  }
  const user = `${NAMESPACE}-${SA_NAME}`;
  return [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    "- name: homelab",
    "  cluster:",
    `    server: ${server}`,
    `    certificate-authority-data: ${data["ca.crt"]}`,
    "users:",
    `- name: ${user}`,
    "  user:",
    `    token: ${Buffer.from(data.token, "base64").toString("utf8")}`,
    "contexts:",
    "- name: homelab-apps-ci",
    "  context:",
    "    cluster: homelab",
    `    user: ${user}`,
    "current-context: homelab-apps-ci",
    "",
  ].join("\n");
}
