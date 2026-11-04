import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { renderKubeconfig } from "../ci-access";

/**
 * Read-only cluster access for the AI operator account on the node (user
 * `aioperator`), so it can diagnose without the owner running kubectl for it.
 *
 * - Built-in ClusterRole `view` cluster-wide: workloads, pods/log, events,
 *   configmaps, services, etc. `view` deliberately excludes Secrets.
 * - Extra cluster-scoped read access `view` does not cover: nodes, PVs,
 *   storage classes, CRDs, namespaces, and the operator CRDs (Longhorn, CNPG,
 *   cert-manager, Traefik, Gateway API, External Secrets, VictoriaMetrics).
 *   Core group only by name, so Secrets stay unreadable.
 * - No write verbs, no pods/exec, no port-forward, no impersonation.
 *
 * Install on the node (once; later via the Ansible host role):
 *   pulumi stack output operatorKubeconfig --show-secrets \
 *     | ssh <node> 'sudo install -D -m 600 -o aioperator -g aioperator /dev/stdin ~aioperator/.kube/config'
 */

const NAMESPACE = "operator-access";
const SA_NAME = "aioperator";
const READ = ["get", "list", "watch"];
const LABELS = {
  "app.kubernetes.io/managed-by": "pulumi-homelab",
  "app.kubernetes.io/part-of": "operator-access",
};

export const operatorClusterReadRules: k8s.types.input.rbac.v1.PolicyRule[] = [
  {
    apiGroups: [""],
    resources: ["nodes", "nodes/status", "namespaces", "persistentvolumes", "componentstatuses"],
    verbs: READ,
  },
  {
    apiGroups: ["storage.k8s.io"],
    resources: ["storageclasses", "csidrivers", "csinodes", "volumeattachments"],
    verbs: READ,
  },
  { apiGroups: ["apiextensions.k8s.io"], resources: ["customresourcedefinitions"], verbs: READ },
  { apiGroups: ["apiregistration.k8s.io"], resources: ["apiservices"], verbs: READ },
  { apiGroups: ["metrics.k8s.io"], resources: ["nodes", "pods"], verbs: READ },
  {
    apiGroups: ["rbac.authorization.k8s.io"],
    resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"],
    verbs: READ,
  },
  {
    // Operator CRDs: these hold state/status, not secret material.
    apiGroups: [
      "longhorn.io",
      "postgresql.cnpg.io",
      "cert-manager.io",
      "acme.cert-manager.io",
      "traefik.io",
      "traefik.containo.us",
      "gateway.networking.k8s.io",
      "external-secrets.io",
      "operator.victoriametrics.com",
    ],
    resources: ["*"],
    verbs: READ,
  },
];

export function createOperatorAccess(args: { apiServer: pulumi.Input<string> }) {
  const ns = new k8s.core.v1.Namespace("operator-access-ns", {
    metadata: {
      name: NAMESPACE,
      labels: {
        ...LABELS,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  });

  const sa = new k8s.core.v1.ServiceAccount("operator-access-sa", {
    metadata: { name: SA_NAME, namespace: ns.metadata.name, labels: LABELS },
  });
  const subject = { kind: "ServiceAccount", name: SA_NAME, namespace: NAMESPACE };

  new k8s.rbac.v1.ClusterRoleBinding("operator-access-view", {
    metadata: { name: "operator-access:aioperator:view", labels: LABELS },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
    subjects: [subject],
  });

  const clusterRead = new k8s.rbac.v1.ClusterRole("operator-access-cluster-read", {
    metadata: { name: "operator-access:aioperator:cluster-read", labels: LABELS },
    rules: operatorClusterReadRules,
  });
  new k8s.rbac.v1.ClusterRoleBinding("operator-access-cluster-read", {
    metadata: { name: "operator-access:aioperator:cluster-read", labels: LABELS },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRead.metadata.name,
    },
    subjects: [subject],
  });

  const tokenSecret = new k8s.core.v1.Secret(
    "operator-access-token",
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
  const token = k8s.core.v1.Secret.get(
    "operator-access-token-read",
    pulumi.interpolate`${NAMESPACE}/${tokenSecret.metadata.name}`,
    { dependsOn: [tokenSecret] }
  );

  const kubeconfig = pulumi
    .all([token.data, pulumi.output(args.apiServer)])
    .apply(([data, server]) =>
      renderKubeconfig(data, server, `${NAMESPACE}-${SA_NAME}`, "homelab-operator-readonly")
    );

  return { serviceAccount: sa, kubeconfig: pulumi.secret(kubeconfig) };
}
