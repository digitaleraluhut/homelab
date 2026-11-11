import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// A PVC on a WaitForFirstConsumer storage class (longhorn-persistent) binds only once a
// pod uses it. If the Deployment waited for the PVC, neither would ever finish.
// The mock models that: the PVC never completes.
const created: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        if (args.type === "kubernetes:core/v1:PersistentVolumeClaim") {
          return new Promise(() => {}) as never;
        }
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "homelab",
    "test",
    false
  );
  const { ExposedWebApp } = await import("./ExposedWebApp");
  new ExposedWebApp("demo", {
    image: "nginxinc/nginx-unprivileged:alpine",
    domain: "demo.example.org",
    port: 8080,
    storage: { size: "1Gi", mountPath: "/data", storageClass: "longhorn-persistent" },
  });
  await new Promise((r) => setTimeout(r, 200));
});

describe("ExposedWebApp with storage", () => {
  it("creates the Deployment without waiting for the PVC to bind", () => {
    expect(created.some((c) => c.type === "kubernetes:core/v1:PersistentVolumeClaim")).toBe(true);
    expect(created.some((c) => c.type === "kubernetes:apps/v1:Deployment")).toBe(true);
  });

  it("mounts the PVC by its fixed name", () => {
    const dep = created.find((c) => c.type === "kubernetes:apps/v1:Deployment");
    type Spec = {
      template: { spec: { volumes: Array<{ persistentVolumeClaim?: { claimName: string } }> } };
    };
    const volumes = (dep?.inputs.spec as Spec).template.spec.volumes;
    expect(volumes.map((v) => v.persistentVolumeClaim?.claimName)).toContain("demo-storage");
  });
});
