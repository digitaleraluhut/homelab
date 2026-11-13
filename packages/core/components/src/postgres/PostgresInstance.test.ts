import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

const created: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        // Secret.get (the CNPG-generated credentials) reads existing state: give it data.
        const state =
          args.id && args.type === "kubernetes:core/v1:Secret" ? { data: {} } : args.inputs;
        return { id: args.id || `${args.name}-id`, state };
      },
      call: (args) => args.inputs,
    },
    "app",
    "test",
    false
  );
  const { PostgresInstance } = await import("./PostgresInstance");
  const namespace = new k8s.core.v1.Namespace("gitea", { metadata: { name: "gitea" } });
  new PostgresInstance("gitea-db", { namespace, databaseName: "gitea" });
  await new Promise((r) => setTimeout(r, 50));
});

describe("PostgresInstance defaults", () => {
  it("uses CloudNativePG's own image, whose postgres user has the default UID 26", () => {
    const cluster = created.find((c) => c.type === "kubernetes:postgresql.cnpg.io/v1:Cluster");
    const spec = cluster?.inputs.spec as {
      imageName: string;
      postgresUID: number;
      postgresGID: number;
    };
    // The Docker Hub image (postgres:18) runs as UID 999: initdb fails with "could not look up
    // effective user ID 26" (observed 2026-11-13, first app on this component: gitea).
    expect(spec.imageName).toBe("ghcr.io/cloudnative-pg/postgresql:18");
    expect(spec.postgresUID).toBe(26);
    expect(spec.postgresGID).toBe(26);
  });
});
