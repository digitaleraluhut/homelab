import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@mrsimpson/homelab-config", () => ({ homelabConfig: { domain: "example.test" } }));

// Pulumi mocks cannot run resource transforms, so ConfigFile is replaced by a component that
// records its arguments; the transform itself is tested directly below.
const configFiles = vi.hoisted(
  () => [] as { name: string; args: { file?: string }; opts: { transforms?: unknown[] } }[]
);
vi.mock("@pulumi/kubernetes", async (importOriginal) => {
  const k8s = await importOriginal<typeof import("@pulumi/kubernetes")>();
  const { ComponentResource } = await import("@pulumi/pulumi");
  class RecordedConfigFile extends ComponentResource {
    constructor(name: string, args: { file?: string }, opts: { transforms?: unknown[] }) {
      super("test:index:ConfigFile", name);
      configFiles.push({ name, args, opts });
    }
  }
  return { ...k8s, yaml: { ...k8s.yaml, v2: { ...k8s.yaml.v2, ConfigFile: RecordedConfigFile } } };
});

type Created = { type: string; name: string; inputs: Record<string, unknown> };
const created: Created[] = [];

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
  await import("./index");
  await new Promise((r) => setTimeout(r, 50));
});

const byName = (name: string) => created.find((c) => c.name === name);
const configFile = (name: string) => configFiles.find((c) => c.name === name);

type Values = {
  service: { type?: string; spec?: { type?: string } };
  ports: { websecure: { tls?: unknown; http?: { tls?: { enabled?: boolean } } } };
  globalArguments?: unknown;
  global?: { checkNewVersion?: boolean; sendAnonymousUsage?: boolean };
};

describe("traefik-gateway", () => {
  it("pins chart 42.2.0 (Traefik v3.7.16), which honours appProtocol kubernetes.io/h2c", () => {
    expect(byName("traefik")?.inputs.version).toBe("42.2.0");
  });

  // Chart >= 40 ignores service.type silently: the Service would become a LoadBalancer.
  // Chart >= 39 rejects ports.<name>.tls and globalArguments by schema.
  it("uses the values syntax of chart >= 40", () => {
    const values = byName("traefik")?.inputs.values as Values;
    expect(values.service.spec?.type).toBe("ClusterIP");
    expect(values.service.type).toBeUndefined();
    expect(values.ports.websecure.http?.tls?.enabled).toBe(true);
    expect(values.ports.websecure.tls).toBeUndefined();
    expect(values.globalArguments).toBeUndefined();
    expect(values.global).toEqual({ checkNewVersion: false, sendAnonymousUsage: false });
  });

  it("applies the Gateway API v1.5.1 and Traefik v3.7.16 CRDs itself", () => {
    expect(configFile("gateway-api-crds")?.args.file).toBe(
      "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml"
    );
    expect(configFile("traefik-crds")?.args.file).toContain("/traefik/v3.7.16/");
    for (const name of ["gateway-api-crds", "traefik-crds"]) {
      expect(configFile(name)?.opts.transforms).toHaveLength(1);
    }
  });

  it("takes over the CRDs from the first Helm install and never deletes them", async () => {
    const { crdTransforms } = await import("./index");
    const [takeover] = crdTransforms;
    const result = await takeover?.({
      custom: true,
      type: "kubernetes:apiextensions.k8s.io/v1:CustomResourceDefinition",
      name: "httproutes",
      props: { metadata: { name: "httproutes", annotations: { keep: "me" } } },
      opts: {},
    });
    const metadata = result?.props.metadata as { annotations: Record<string, string> };
    expect(metadata.annotations).toEqual({ keep: "me", "pulumi.com/patchForce": "true" });
    expect(result?.opts.retainOnDelete).toBe(true);
  });
});
