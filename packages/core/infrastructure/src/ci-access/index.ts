import {
  APP_NAMESPACE_LABEL,
  APP_NAMESPACE_OWNER,
  CI_SUBJECT,
  DEPLOYER_ROLE,
} from "@mrsimpson/homelab-core-components";
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
 * - Each app creates its own namespace and binds the deployer role to this ServiceAccount there
 *   (homelab-core-components: createAppNamespace). Adding an app needs no change here.
 * - Admission policies fence that: namespaces the CI creates or changes must carry
 *   `homelab/deployer: homelab-apps` and pod-security `restricted`; it cannot change or delete
 *   any other namespace, and creates RoleBindings only in its own namespaces.
 * - observability: the opencode dashboard ConfigMap + its sync Job.
 * - No other cluster-scoped writes, no pods/exec or port-forward anywhere.
 *
 * Get the kubeconfig for the GitHub environment secret:
 *   pulumi stack output ciAppsKubeconfig --show-secrets | base64 | tr -d '\n'
 */

export interface CiAccessArgs {
  /** API server URL reachable from CI runners (Tailscale address of the node). */
  apiServer: string;
}

const NAMESPACE = CI_SUBJECT.namespace;
const SA_NAME = CI_SUBJECT.name;
const SA_USER = `system:serviceaccount:${NAMESPACE}:${SA_NAME}`;

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
  const ns = new k8s.core.v1.Namespace("ci-access-ns", {
    metadata: {
      name: NAMESPACE,
      labels: { ...LABELS, "pod-security.kubernetes.io/enforce": "restricted" },
    },
  });

  const sa = new k8s.core.v1.ServiceAccount("ci-homelab-apps-sa", {
    metadata: { name: SA_NAME, namespace: ns.metadata.name, labels: LABELS },
  });
  const subject = CI_SUBJECT;

  const deployerRole = new k8s.rbac.v1.ClusterRole("ci-homelab-apps-deployer", {
    metadata: { name: DEPLOYER_ROLE, labels: LABELS },
    rules: appDeployerRules,
  });

  // The fences come first: the rights below are only safe with the policies in force.
  const owned = `has(%s.metadata.labels) && '${APP_NAMESPACE_LABEL}' in %s.metadata.labels && %s.metadata.labels['${APP_NAMESPACE_LABEL}'] == '${APP_NAMESPACE_OWNER}'`;
  const isOwned = (o: string) => owned.split("%s").join(o);
  const fences = [
    {
      name: "ci-homelab-apps-namespaces",
      resources: [{ apiGroups: [""], apiVersions: ["v1"], resources: ["namespaces"] }],
      validations: [
        {
          expression: `request.operation == 'DELETE' || (${isOwned("object")} && 'pod-security.kubernetes.io/enforce' in object.metadata.labels && object.metadata.labels['pod-security.kubernetes.io/enforce'] == 'restricted' && (!('pod-security.kubernetes.io/enforce-version' in object.metadata.labels) || object.metadata.labels['pod-security.kubernetes.io/enforce-version'] == 'latest'))`,
          message: `CI namespaces need ${APP_NAMESPACE_LABEL}=${APP_NAMESPACE_OWNER} and pod-security enforce=restricted (latest)`,
        },
        {
          expression: `request.operation == 'CREATE' || (${isOwned("oldObject")})`,
          message: "CI may only change or delete namespaces it owns",
        },
      ],
    },
    {
      name: "ci-homelab-apps-rolebindings",
      resources: [
        {
          apiGroups: ["rbac.authorization.k8s.io"],
          apiVersions: ["v1"],
          resources: ["rolebindings"],
        },
      ],
      validations: [
        {
          expression: isOwned("namespaceObject"),
          message: "CI may only manage RoleBindings in namespaces it owns",
        },
      ],
    },
  ];
  const fenceBindings = fences.map((f) => {
    const policy = new k8s.admissionregistration.v1.ValidatingAdmissionPolicy(f.name, {
      metadata: {
        name: f.name.replace("ci-homelab-apps-", "ci-access.homelab-apps."),
        labels: LABELS,
      },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: f.resources.map((r) => ({
            ...r,
            operations: ["CREATE", "UPDATE", "DELETE"],
          })),
        },
        matchConditions: [
          { name: "homelab-apps-ci", expression: `request.userInfo.username == '${SA_USER}'` },
        ],
        validations: f.validations,
      },
    });
    return new k8s.admissionregistration.v1.ValidatingAdmissionPolicyBinding(f.name, {
      metadata: { name: policy.metadata.name, labels: LABELS },
      spec: { policyName: policy.metadata.name, validationActions: ["Deny"] },
    });
  });

  const nsRole = new k8s.rbac.v1.ClusterRole("ci-homelab-apps-namespaces", {
    metadata: { name: "ci-access:homelab-apps:namespaces", labels: LABELS },
    rules: [
      { apiGroups: [""], resources: ["namespaces"], verbs: ALL },
      { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"], verbs: ALL },
      {
        apiGroups: ["rbac.authorization.k8s.io"],
        resources: ["clusterroles"],
        resourceNames: [DEPLOYER_ROLE],
        verbs: ["bind"],
      },
    ],
  });
  new k8s.rbac.v1.ClusterRoleBinding(
    "ci-homelab-apps-namespaces",
    {
      metadata: { name: "ci-access:homelab-apps:namespaces", labels: LABELS },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: nsRole.metadata.name,
      },
      subjects: [subject],
    },
    { dependsOn: [...fenceBindings, deployerRole] }
  );

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
export function renderKubeconfig(
  data: Record<string, string> | undefined,
  server: string,
  user = `${NAMESPACE}-${SA_NAME}`,
  context = "homelab-apps-ci"
): string {
  if (!data?.token || !data?.["ca.crt"]) {
    return "token not populated yet - run the deploy once more";
  }
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
    `- name: ${context}`,
    "  context:",
    "    cluster: homelab",
    `    user: ${user}`,
    `current-context: ${context}`,
    "",
  ].join("\n");
}
