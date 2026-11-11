import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

type Created = { type: string; name: string; inputs: Record<string, unknown> };
const created: Created[] = [];

const CA = Buffer.from("FAKE-CA").toString("base64");
const TOKEN = Buffer.from("fake-token").toString("base64");

beforeAll(() => {
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
});

async function load() {
  const mod = await import("./index");
  return mod.createCiAccess({
    apiServer: "https://ci.example:6443",
  });
}

type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] };
const clusterRole = (name: string) =>
  created.find(
    (c) => c.name === name && c.type === "kubernetes:rbac.authorization.k8s.io/v1:ClusterRole"
  );
const policies = () =>
  created.filter(
    (c) => c.type === "kubernetes:admissionregistration.k8s.io/v1:ValidatingAdmissionPolicy"
  );

describe("createCiAccess", () => {
  it("creates no app namespaces and no per-app bindings (apps create their own)", async () => {
    await load();
    await new Promise((r) => setTimeout(r, 50));
    const nss = created.filter((c) => c.type === "kubernetes:core/v1:Namespace");
    expect(nss.map((c) => (c.inputs.metadata as { name: string }).name)).toEqual(["ci-access"]);
    expect(created.some((c) => c.name.startsWith("ci-homelab-apps-deployer-"))).toBe(false);
  });

  it("lets CI manage namespaces and rolebindings, and bind only the deployer role", () => {
    const rules = clusterRole("ci-homelab-apps-namespaces")?.inputs.rules as Rule[];
    const bind = rules.filter((r) => r.verbs.includes("bind"));
    expect(bind).toHaveLength(1);
    expect(bind[0]?.resources).toEqual(["clusterroles"]);
    expect(bind[0]?.resourceNames).toEqual(["ci-access:homelab-apps:deployer"]);
    expect(
      rules.some((r) => r.resources.includes("namespaces") && r.verbs.includes("create"))
    ).toBe(true);
    expect(
      rules.some((r) => r.resources.includes("rolebindings") && r.verbs.includes("create"))
    ).toBe(true);
  });

  it("fences CI namespaces: own label and pod-security restricted, never foreign ones", () => {
    const ns = policies().find((p) => JSON.stringify(p.inputs).includes('"namespaces"'));
    const text = JSON.stringify(ns?.inputs);
    expect(text).toContain("system:serviceaccount:ci-access:homelab-apps");
    expect(text).toContain("homelab/deployer");
    expect(text).toContain("restricted");
    expect(text).toContain("oldObject");
  });

  it("fences CI rolebindings to its own namespaces", () => {
    const rb = policies().find((p) => JSON.stringify(p.inputs).includes('"rolebindings"'));
    const text = JSON.stringify(rb?.inputs);
    expect(text).toContain("namespaceObject");
    expect(text).toContain("homelab/deployer");
  });

  it("enforces both policies (Deny)", () => {
    const bindings = created.filter(
      (c) =>
        c.type === "kubernetes:admissionregistration.k8s.io/v1:ValidatingAdmissionPolicyBinding"
    );
    expect(bindings).toHaveLength(2);
    for (const b of bindings) {
      expect((b.inputs.spec as { validationActions: string[] }).validationActions).toEqual([
        "Deny",
      ]);
    }
  });

  it("grants no exec, port-forward or cluster-scoped writes in the deployer role", () => {
    const role = created.find(
      (c) => c.name === "ci-homelab-apps-deployer" && c.type.endsWith("ClusterRole")
    );
    const resources = (role?.inputs.rules as { resources: string[] }[]).flatMap((r) => r.resources);
    for (const forbidden of [
      "pods/exec",
      "pods/portforward",
      "namespaces",
      "clusterroles",
      "clusterrolebindings",
      "customresourcedefinitions",
      "clustersecretstores",
    ]) {
      expect(resources).not.toContain(forbidden);
    }
  });

  it("renders a kubeconfig once the token is populated", async () => {
    const { renderKubeconfig } = await import("./index");
    const kc = renderKubeconfig({ token: TOKEN, "ca.crt": CA }, "https://ci.example:6443");
    expect(kc).toContain("server: https://ci.example:6443");
    expect(kc).toContain(`certificate-authority-data: ${CA}`);
    expect(kc).toContain("token: fake-token");
    expect(renderKubeconfig(undefined, "x")).toMatch(/not populated/);
  });
});
