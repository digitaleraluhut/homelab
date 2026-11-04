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
    appNamespaces: ["app-a", "app-b", "app-new"],
    existingNamespaces: ["app-a", "app-b"],
    apiServer: "https://ci.example:6443",
  });
}

describe("createCiAccess", () => {
  it("binds the deployer role only in the app namespaces", async () => {
    await load();
    await new Promise((r) => setTimeout(r, 50));
    const bindings = created.filter(
      (c) =>
        c.type === "kubernetes:rbac.authorization.k8s.io/v1:RoleBinding" &&
        c.name.startsWith("ci-homelab-apps-deployer-")
    );
    expect(
      bindings.map((b) => (b.inputs.metadata as { namespace: string }).namespace).sort()
    ).toEqual(["app-a", "app-b", "app-new"]);
  });

  it("creates only namespaces that do not exist yet", () => {
    const nss = created
      .filter((c) => c.type === "kubernetes:core/v1:Namespace")
      .map((c) => (c.inputs.metadata as { name: string }).name)
      .sort();
    expect(nss).toEqual(["app-new", "ci-access"]);
  });

  it("labels namespaces it creates as pod-security restricted", () => {
    const ns = created.find(
      (c) =>
        c.type === "kubernetes:core/v1:Namespace" &&
        (c.inputs.metadata as { name: string }).name === "app-new"
    );
    const labels = (ns?.inputs.metadata as { labels: Record<string, string> }).labels;
    for (const mode of ["enforce", "audit", "warn"]) {
      expect(labels[`pod-security.kubernetes.io/${mode}`]).toBe("restricted");
    }
  });

  it("limits namespace update/patch/delete to the app namespaces", () => {
    const role = created.find(
      (c) => c.name === "ci-homelab-apps-namespaces" && c.type.endsWith("ClusterRole")
    );
    const rules = role?.inputs.rules as { verbs: string[]; resourceNames?: string[] }[];
    const destructive = rules.filter((r) =>
      r.verbs.some((v) => ["update", "patch", "delete"].includes(v))
    );
    expect(destructive).toHaveLength(1);
    expect(destructive[0]?.resourceNames).toEqual(["app-a", "app-b", "app-new"]);
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
