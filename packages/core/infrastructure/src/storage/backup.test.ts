import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// The backup bucket lives in R2's EU jurisdiction. Its S3 API answers only on the
// account's ".eu." endpoint; the default endpoint returns 403 AccessDenied.
const ACCOUNT = "0123456789abcdef0123456789abcdef";

let backup: typeof import("./backup");
let buckets: typeof import("./r2-buckets");

beforeAll(async () => {
  process.env.PULUMI_CONFIG = JSON.stringify({ "homelab:cloudflareAccountId": ACCOUNT });
  pulumi.runtime.setMocks(
    {
      newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }),
      call: (args) => args.inputs,
    },
    "homelab",
    "test",
    false
  );
  backup = await import("./backup");
  buckets = await import("./r2-buckets");
});

describe("getBackupConfig", () => {
  it("points Longhorn at the EU jurisdiction endpoint of the account", () => {
    expect(backup.getBackupConfig().s3Endpoint).toBe(
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`
    );
  });

  it("uses the same endpoint as the bucket definition", () => {
    expect(backup.getBackupConfig().s3Endpoint).toBe(buckets.r2Endpoint);
  });
});
