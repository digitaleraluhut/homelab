import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// The resources move from stack mrsimpson/aftertouch/dev with `pulumi state move`. That only
// keeps them (and the data volume) if type, name and parent stay exactly as they were.
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
    "homelab",
    "dev",
    false
  );
  pulumi.runtime.setAllConfig({
    "aftertouch:image": "ghcr.io/gesellix/bose-soundtouch:0.86",
    "aftertouch:nodeIp": "192.0.2.5",
    "aftertouch:nodeName": "flinker",
    "aftertouch:mgmtUsername": "u",
    "aftertouch:mgmtPassword": "p",
  });
  const { setupAftertouch } = await import("./index");
  setupAftertouch();
  await new Promise((r) => setTimeout(r, 50));
});

describe("setupAftertouch", () => {
  it("declares exactly the resources of the former aftertouch stack, same types and names", () => {
    expect(created.map((c) => `${c.type}::${c.name}`).sort()).toEqual(
      [
        "kubernetes:core/v1:Namespace::aftertouch-ns",
        "kubernetes:core/v1:Secret::aftertouch-mgmt",
        "kubernetes:core/v1:PersistentVolumeClaim::aftertouch-pvc",
        "kubernetes:apps/v1:Deployment::aftertouch-deployment",
        "kubernetes:core/v1:Service::aftertouch-svc",
        "kubernetes:core/v1:Service::aftertouch-http",
        "kubernetes:core/v1:Service::aftertouch-https",
        "kubernetes:core/v1:Service::aftertouch-web",
      ].sort()
    );
  });

  it("keeps the data volume claim name", () => {
    const pvc = created.find((c) => c.name === "aftertouch-pvc");
    expect((pvc?.inputs.metadata as { name: string }).name).toBe("aftertouch-data");
  });
});
