import { beforeAll, describe, expect, it } from "vitest";
import type { GroupConfig } from "./groups";

// groups.ts reads Pulumi config on import. Provide it via the environment so the
// test needs no stack config (and no secrets).
let groups: Record<string, GroupConfig>;

beforeAll(async () => {
  process.env.PULUMI_CONFIG = JSON.stringify({
    "oauth2-proxy:usersEmails": JSON.stringify(["user@example.com"]),
    "oauth2-proxy:developersEmails": JSON.stringify(["dev@example.com"]),
  });
  ({ groups } = await import("./groups"));
});

describe("groups", () => {
  it("defines a developers group", () => {
    expect(groups.developers).toBeDefined();
  });

  it("developers group has required scopes for dev flows", () => {
    const dev = groups.developers;
    expect(dev?.scopes).toEqual(["user:email", "repo", "read:org", "workflow", "gist"]);
  });

  it("GroupConfig does not expose callbackSubdomain", () => {
    for (const [_name, config] of Object.entries(groups)) {
      // callbackSubdomain is an internal routing concern, not part of GroupConfig
      expect(Object.keys(config)).not.toContain("callbackSubdomain");
    }
  });

  it("all groups have at least one email", () => {
    for (const [name, config] of Object.entries(groups)) {
      expect(config.emails.length, `Group "${name}" has no emails`).toBeGreaterThan(0);
    }
  });
});
