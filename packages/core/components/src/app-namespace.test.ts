import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

const created: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "app",
    "test",
    false
  );
  const { createAppNamespace } = await import("./app-namespace");
  createAppNamespace("gitea");
  await new Promise((r) => setTimeout(r, 50));
});

const of = (type: string) => created.find((c) => c.type === type);

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
});
