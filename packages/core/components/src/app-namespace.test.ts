import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

const created: Array<{
  type: string;
  name: string;
  id?: string;
  inputs: Record<string, unknown>;
}> = [];
let result: { namespace: pulumi.Resource } | undefined;

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, id: args.id, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "app",
    "test",
    false
  );
  const { createAppNamespace } = await import("./app-namespace");
  result = createAppNamespace("gitea");
  await new Promise((r) => setTimeout(r, 50));
});

const of = (type: string) => created.find((c) => c.type === type && !c.id);

describe("createAppNamespace", () => {
  it("creates the namespace owned by the CI, pod-security restricted", () => {
    const meta = of("kubernetes:core/v1:Namespace")?.inputs.metadata as {
      name: string;
      labels: Record<string, string>;
    };
    expect(meta.name).toBe("gitea");
    expect(meta.labels["homelab/deployer"]).toBe("homelab-apps");
    for (const mode of ["enforce", "audit", "warn"]) {
      expect(meta.labels[`pod-security.kubernetes.io/${mode}`]).toBe("restricted");
    }
  });

  it("binds the deployer role to the CI ServiceAccount in that namespace", () => {
    const rb = of("kubernetes:rbac.authorization.k8s.io/v1:RoleBinding")?.inputs as {
      metadata: { namespace: string };
      roleRef: { kind: string; name: string };
      subjects: Array<{ name: string; namespace: string }>;
    };
    expect(rb.metadata.namespace).toBe("gitea");
    expect(rb.roleRef).toMatchObject({
      kind: "ClusterRole",
      name: "ci-access:homelab-apps:deployer",
    });
    expect(rb.subjects).toEqual([
      { kind: "ServiceAccount", name: "homelab-apps", namespace: "ci-access" },
    ]);
  });

  it("hands out the namespace only once the CI may deploy into it", async () => {
    // Pulumi does not pass a component's dependsOn on to its children, so an app's resources
    // must reach the namespace through something that waits for the RoleBinding.
    const read = created.findIndex((c) => c.type === "kubernetes:core/v1:Namespace" && c.id);
    const binding = created.findIndex(
      (c) => c.type === "kubernetes:rbac.authorization.k8s.io/v1:RoleBinding"
    );
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(binding);
    expect(created[read].id).toBe("gitea");
    const urn = await new Promise((r) => (result?.namespace.urn as pulumi.Output<string>).apply(r));
    expect(urn).toContain("gitea-ns-ready");
  });
});
