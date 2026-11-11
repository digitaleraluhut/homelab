import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// Preview of a first deploy: nothing exists yet. The namespace reference must not be read with
// a known ID (a read of a namespace that does not exist fails the whole preview). With an
// unknown ID the engine skips the read in a preview.
const reads: string[] = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        if (args.id && args.id !== pulumi.runtime.unknownValue) reads.push(args.name);
        // In a preview, resources to be created have no ID yet.
        return { id: args.id ?? "", state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "app",
    "test",
    true
  );
  const { createAppNamespace } = await import("./app-namespace");
  createAppNamespace("gitea");
  await new Promise((r) => setTimeout(r, 50));
});

describe("createAppNamespace in a preview", () => {
  it("does not read the namespace before the RoleBinding exists", () => {
    expect(reads).toEqual([]);
  });
});
