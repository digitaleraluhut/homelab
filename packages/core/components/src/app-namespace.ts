import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/**
 * The namespace contract between the homelab-apps CI and the cluster.
 * The homelab stack (core-infrastructure ci-access) admits CI-created namespaces and
 * RoleBindings only if they follow it; apps create theirs with createAppNamespace().
 */
export const APP_NAMESPACE_LABEL = "homelab/deployer";
export const APP_NAMESPACE_OWNER = "homelab-apps";
export const DEPLOYER_ROLE = "ci-access:homelab-apps:deployer";
export const CI_SUBJECT = { kind: "ServiceAccount", name: "homelab-apps", namespace: "ci-access" };

/**
 * Creates an app's namespace (pod-security restricted, owned by the CI) and grants the CI
 * its deployer rights there.
 *
 * Use the returned `namespace` for everything else the app creates (e.g. ExposedWebApp's
 * `namespace`, `dependsOn: [namespace]`). It is a reference that resolves only after the
 * RoleBinding exists, so no resource is sent to the cluster before the CI may create it.
 * (`dependsOn` on a component does not reach its children; a data dependency does.)
 */
export function createAppNamespace(name: string, opts?: pulumi.CustomResourceOptions) {
  const created = new k8s.core.v1.Namespace(
    `${name}-ns`,
    {
      metadata: {
        name,
        labels: {
          [APP_NAMESPACE_LABEL]: APP_NAMESPACE_OWNER,
          "app.kubernetes.io/name": name,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
      },
    },
    opts
  );
  const binding = new k8s.rbac.v1.RoleBinding(
    `${name}-deployer`,
    {
      metadata: { name: "homelab-apps:deployer", namespace: name },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: DEPLOYER_ROLE },
      subjects: [CI_SUBJECT],
    },
    { ...opts, dependsOn: [created] }
  );
  const namespace = k8s.core.v1.Namespace.get(`${name}-ns-ready`, binding.metadata.namespace, {
    ...opts,
    dependsOn: [binding],
  });
  return { namespace, binding };
}
