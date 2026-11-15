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
  const { ExposedWebApp, AuthType } = await import("./ExposedWebApp");
  new ExposedWebApp("demo", {
    image: "nginxinc/nginx-unprivileged:alpine",
    domain: "demo.example.org",
    port: 8080,
    storage: { size: "1Gi", mountPath: "/data", storageClass: "longhorn-persistent" },
  });
  new ExposedWebApp("single-writer", {
    image: "nginxinc/nginx-unprivileged:alpine",
    domain: "single-writer.example.org",
    port: 8080,
    strategy: "Recreate",
  });
  new ExposedWebApp("grpc", {
    image: "ghcr.io/zitadel/zitadel:v4.20.3",
    domain: "grpc.example.org",
    port: 8080,
    backendProtocol: "h2c",
  });
  new ExposedWebApp("grpc-oauth", {
    image: "ghcr.io/zitadel/zitadel:v4.20.3",
    domain: "grpc-oauth.example.org",
    port: 8080,
    auth: AuthType.OAUTH2_PROXY,
    backendProtocol: "h2c",
  });
  new ExposedWebApp("plain-oauth", {
    image: "nginxinc/nginx-unprivileged:alpine",
    domain: "plain-oauth.example.org",
    port: 8080,
    auth: AuthType.OAUTH2_PROXY,
  });
  await new Promise((r) => setTimeout(r, 200));
});

describe("ExposedWebApp with storage", () => {
  it("creates the Deployment without waiting for the PVC to bind", () => {
    expect(created.some((c) => c.type === "kubernetes:core/v1:PersistentVolumeClaim")).toBe(true);
    expect(created.some((c) => c.type === "kubernetes:apps/v1:Deployment")).toBe(true);
  });

  it("mounts the PVC by its fixed name", () => {
    const dep = created.find(
      (c) => c.type === "kubernetes:apps/v1:Deployment" && c.name === "demo-deployment"
    );
    type Spec = {
      template: { spec: { volumes: Array<{ persistentVolumeClaim?: { claimName: string } }> } };
    };
    const volumes = (dep?.inputs.spec as Spec).template.spec.volumes;
    expect(volumes.map((v) => v.persistentVolumeClaim?.claimName)).toContain("demo-storage");
  });
});

describe("ExposedWebApp deployment strategy", () => {
  type Dep = { metadata: { name: string }; strategy?: { type: string } };
  const spec = (name: string) =>
    created.find(
      (c) => c.type === "kubernetes:apps/v1:Deployment" && c.name === `${name}-deployment`
    )?.inputs.spec as Dep | undefined;

  it("keeps Kubernetes' default (rolling update) unless asked", () => {
    expect(spec("demo")?.strategy).toBeUndefined();
  });

  it("stops the old pod before starting the new one with Recreate", () => {
    // Apps whose data volume is ReadWriteOnce or that lock files in it (e.g. Gitea's queue
    // database) cannot run two pods at once during a rollout.
    expect(spec("single-writer")?.strategy).toEqual({ type: "Recreate" });
  });
});

describe("ExposedWebApp backend protocol", () => {
  type Port = { name: string; port: number; appProtocol?: string };
  const servicePorts = (name: string) =>
    (
      created.find((c) => c.type === "kubernetes:core/v1:Service" && c.name === `${name}-service`)
        ?.inputs.spec as { ports: Port[] }
    ).ports;
  type Route = { services: Array<{ port: number; scheme?: string }> };
  const appRouteServices = (name: string) =>
    (
      created.find((c) => c.name === `${name}-oauth2-app-route`)?.inputs.spec as {
        routes: Route[];
      }
    ).routes[0].services;

  it("leaves the Service and IngressRoute unchanged unless asked", () => {
    expect(servicePorts("demo")).toEqual([
      { port: 80, targetPort: 8080, protocol: "TCP", name: "http" },
    ]);
    expect(appRouteServices("plain-oauth")[0]).not.toHaveProperty("scheme");
  });

  it("marks the Service port as h2c, which Traefik's Gateway API provider reads for HTTPRoutes", () => {
    // Apps like Zitadel need HTTP/2 between proxy and pod (gRPC).
    expect(servicePorts("grpc")).toEqual([
      {
        port: 80,
        targetPort: 8080,
        protocol: "TCP",
        name: "http",
        appProtocol: "kubernetes.io/h2c",
      },
    ]);
  });

  it("sets scheme h2c on the app's IngressRoute service (OAuth2-Proxy)", () => {
    expect(servicePorts("grpc-oauth")[0].appProtocol).toBe("kubernetes.io/h2c");
    expect(appRouteServices("grpc-oauth")[0].scheme).toBe("h2c");
  });
});
