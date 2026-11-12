import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

type Created = { type: string; name: string; inputs: Record<string, unknown> };
const created: Created[] = [];
let access: { readers: Record<string, unknown> };

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "homelab",
    "test",
    false
  );
  const { createOperatorAccess } = await import("./index");
  access = createOperatorAccess({ apiServer: "https://127.0.0.1:6443", readers: ["walle"] });
  await new Promise((r) => setTimeout(r, 50));
});

type Rule = { apiGroups: string[]; resources: string[]; verbs: string[] };

describe("createOperatorAccess", () => {
  it("binds the built-in view role (which excludes secrets)", () => {
    const b = created.find((c) => c.name === "operator-access-view");
    expect((b?.inputs.roleRef as { name: string }).name).toBe("view");
  });

  it("grants only read verbs in its own cluster role", () => {
    const role = created.find(
      (c) => c.name === "operator-access-cluster-read" && c.type.endsWith("ClusterRole")
    );
    const verbs = new Set((role?.inputs.rules as Rule[]).flatMap((r) => r.verbs));
    expect([...verbs].sort()).toEqual(["get", "list", "watch"]);
  });

  it("never grants secrets, exec or wildcards in the core group", () => {
    const role = created.find(
      (c) => c.name === "operator-access-cluster-read" && c.type.endsWith("ClusterRole")
    );
    for (const r of role?.inputs.rules as Rule[]) {
      expect(r.resources).not.toContain("secrets");
      expect(r.resources).not.toContain("pods/exec");
      if (r.apiGroups.includes("")) expect(r.resources).not.toContain("*");
    }
  });

  it("can read runtime and priority classes (runner/runtime diagnostics)", () => {
    const role = created.find(
      (c) => c.name === "operator-access-cluster-read" && c.type.endsWith("ClusterRole")
    );
    const rules = role?.inputs.rules as Rule[];
    const can = (group: string, resource: string) =>
      rules.some((r) => r.apiGroups.includes(group) && r.resources.includes(resource));
    expect(can("node.k8s.io", "runtimeclasses")).toBe(true);
    expect(can("scheduling.k8s.io", "priorityclasses")).toBe(true);
  });

  it("can read admission policies and webhooks (checks the CI fences of ci-access)", () => {
    const role = created.find(
      (c) => c.name === "operator-access-cluster-read" && c.type.endsWith("ClusterRole")
    );
    const rules = role?.inputs.rules as Rule[];
    const can = (resource: string) =>
      rules.some(
        (r) =>
          r.apiGroups.includes("admissionregistration.k8s.io") && r.resources.includes(resource)
      );
    for (const resource of [
      "validatingadmissionpolicies",
      "validatingadmissionpolicybindings",
      "validatingwebhookconfigurations",
      "mutatingwebhookconfigurations",
    ]) {
      expect(can(resource)).toBe(true);
    }
  });
});

describe("additional read-only readers (WALL-E)", () => {
  type Subject = { kind: string; name: string; namespace: string };
  const subjectsOf = (name: string) =>
    (created.find((c) => c.name === name)?.inputs.subjects as Subject[]) ?? [];

  it("creates its own service account", () => {
    const sa = created.find((c) => c.name === "operator-access-walle-sa");
    expect((sa?.inputs.metadata as { name: string }).name).toBe("walle");
  });

  it("binds it to view and to the shared cluster-read role, nothing else", () => {
    const view = created.find((c) => c.name === "operator-access-walle-view");
    expect((view?.inputs.roleRef as { name: string }).name).toBe("view");
    expect(subjectsOf("operator-access-walle-view").map((s) => s.name)).toEqual(["walle"]);
    expect(subjectsOf("operator-access-walle-cluster-read").map((s) => s.name)).toEqual(["walle"]);
    const roles = created.filter((c) => c.type.endsWith("/v1:ClusterRole"));
    expect(roles.map((r) => r.name)).toEqual(["operator-access-cluster-read"]);
  });

  it("keeps the operator's resources as they are", () => {
    expect(subjectsOf("operator-access-view").map((s) => s.name)).toEqual(["aioperator"]);
    expect(created.some((c) => c.name === "operator-access-sa")).toBe(true);
  });

  it("returns a kubeconfig per reader", () => {
    expect(Object.keys(access.readers)).toEqual(["walle"]);
  });
});
