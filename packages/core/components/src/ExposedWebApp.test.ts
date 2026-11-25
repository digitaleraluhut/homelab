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
    enableServiceLinks: false,
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
  // Zitadel v4: the Login V2 is its own service at /ui/v2/login on the core's host.
  const login = { pathPrefix: "/ui/v2/login", serviceName: "zitadel-login", servicePort: 3000 };
  new ExposedWebApp("paths", {
    image: "ghcr.io/zitadel/zitadel:v4.20.3",
    domain: "paths.example.org",
    port: 8080,
    extraRoutes: [login],
  });
  new ExposedWebApp("paths-forward", {
    image: "ghcr.io/zitadel/zitadel:v4.20.3",
    domain: "paths-forward.example.org",
    port: 8080,
    auth: AuthType.FORWARD,
    extraRoutes: [login],
  });
  new ExposedWebApp("paths-oauth", {
    image: "ghcr.io/zitadel/zitadel:v4.20.3",
    domain: "paths-oauth.example.org",
    port: 8080,
    auth: AuthType.OAUTH2_PROXY,
    extraRoutes: [login, { ...login, pathPrefix: "/grpc", backendProtocol: "h2c" }],
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

describe("ExposedWebApp extra routes (path prefixes to other services)", () => {
  type Rule = { matches: unknown[]; backendRefs: unknown[]; filters?: unknown[] };
  const httpRoute = (name: string) =>
    created.find((c) => c.name === `${name}-httproute`)?.inputs.spec as {
      hostnames: string[];
      rules: Rule[];
    };
  const appRoutes = (name: string) =>
    (
      created.find((c) => c.name === `${name}-oauth2-app-route`)?.inputs.spec as {
        routes: unknown[];
      }
    ).routes;
  const appRule = {
    matches: [{ path: { type: "PathPrefix", value: "/" } }],
    backendRefs: [{ name: "paths", port: 80 }],
  };

  it("renders the HTTPRoute unchanged unless asked", () => {
    expect(httpRoute("demo")).toEqual({
      parentRefs: [{ name: "homelab-gateway", namespace: "traefik-system" }],
      hostnames: ["demo.example.org"],
      rules: [
        {
          matches: [{ path: { type: "PathPrefix", value: "/" } }],
          backendRefs: [{ name: "demo", port: 80 }],
        },
      ],
    });
  });

  it("checks OAuth2 sessions at the proxy root, without an errors middleware (homelab#177)", () => {
    type Spec = { forwardAuth: { address: string }; chain: { middlewares: unknown[] } };
    const mw = (n: string) => created.find((c) => c.name === n)?.inputs.spec as Spec | undefined;
    expect(mw("plain-oauth-oauth2-forwardauth")?.forwardAuth.address).toBe(
      "http://oauth2-proxy-users.oauth2-proxy.svc.cluster.local/"
    );
    expect(created.some((c) => c.name === "plain-oauth-oauth2-errors")).toBe(false);
    // The chain keeps its name (apps reference it) and holds only the forwardAuth.
    // The real scheme first (TLS ends at Cloudflare), so the return address is https.
    expect(mw("plain-oauth-oauth2-chain")?.chain.middlewares).toEqual([
      { name: "plain-oauth-oauth2-https" },
      { name: "plain-oauth-oauth2-forwardauth" },
    ]);
    expect(
      (
        created.find((c) => c.name === "plain-oauth-oauth2-https")?.inputs.spec as {
          headers: unknown;
        }
      ).headers
    ).toEqual({ customRequestHeaders: { "X-Forwarded-Proto": "https" } });
  });

  it("renders the OAuth2 IngressRoute unchanged unless asked", () => {
    expect(appRoutes("plain-oauth")).toEqual([
      {
        match: "Host(`plain-oauth.example.org`)",
        kind: "Rule",
        middlewares: [{ name: "plain-oauth-oauth2-chain", namespace: "plain-oauth" }],
        services: [{ name: "plain-oauth", port: 80 }],
        priority: 1,
      },
    ]);
  });

  it("routes a path prefix to another service in an HTTPRoute rule before the app's rule", () => {
    // Gateway API: the longest PathPrefix wins across rules, so /ui/v2/login beats /.
    expect(httpRoute("paths").rules).toEqual([
      {
        matches: [{ path: { type: "PathPrefix", value: "/ui/v2/login" } }],
        backendRefs: [{ name: "zitadel-login", port: 3000 }],
      },
      appRule,
    ]);
  });

  it("puts the extra paths behind the same Authelia filters as the app", () => {
    const rules = httpRoute("paths-forward").rules;
    expect(rules).toHaveLength(2);
    expect(rules[0].filters).toBeDefined();
    expect(rules[0].filters).toEqual(rules[1].filters);
  });

  it("adds IngressRoute routes behind the same OAuth2 chain, above the catch-all", () => {
    const routes = appRoutes("paths-oauth");
    const chain = [{ name: "paths-oauth-oauth2-chain", namespace: "paths-oauth" }];
    expect(routes).toHaveLength(3);
    // No explicit priority: Traefik's default is the rule's length, which is always above the
    // catch-all's priority 1 and lets the longest prefix win among extra routes.
    expect(routes.slice(1)).toEqual([
      {
        match: "Host(`paths-oauth.example.org`) && PathPrefix(`/ui/v2/login`)",
        kind: "Rule",
        middlewares: chain,
        services: [{ name: "zitadel-login", port: 3000 }],
      },
      {
        match: "Host(`paths-oauth.example.org`) && PathPrefix(`/grpc`)",
        kind: "Rule",
        middlewares: chain,
        services: [{ name: "zitadel-login", port: 3000, scheme: "h2c" }],
      },
    ]);
  });

  it.each(["ui/v2/login", "/", "/ui/*", "", "/ui//login"])(
    "refuses the path prefix %j",
    async (pathPrefix) => {
      const { ExposedWebApp } = await import("./ExposedWebApp");
      expect(
        () =>
          new ExposedWebApp(`bad-${pathPrefix.length}`, {
            image: "nginxinc/nginx-unprivileged:alpine",
            domain: "bad.example.org",
            port: 8080,
            extraRoutes: [{ pathPrefix, serviceName: "other", servicePort: 80 }],
          })
      ).toThrow(/pathPrefix/);
    }
  );
});

describe("ExposedWebApp service links", () => {
  type Pod = { enableServiceLinks?: boolean };
  const pod = (name: string) =>
    (
      created.find(
        (c) => c.type === "kubernetes:apps/v1:Deployment" && c.name === `${name}-deployment`
      )?.inputs.spec as { template: { spec: Pod } } | undefined
    )?.template.spec;

  it("keeps Kubernetes' default (service links on) unless asked", () => {
    expect(pod("demo")).toBeDefined();
    expect(pod("demo")?.enableServiceLinks).toBeUndefined();
  });

  it("turns service links off when asked", () => {
    // Apps that read every prefixed variable (Zitadel: ZITADEL_*) misread injected service-link
    // variables such as ZITADEL_PORT=tcp://… for a Service named like the app.
    expect(pod("single-writer")?.enableServiceLinks).toBe(false);
  });
});
