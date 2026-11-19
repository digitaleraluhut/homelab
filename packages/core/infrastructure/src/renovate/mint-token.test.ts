import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM script that runs in the init container, no type declarations
import { appJwt, main, mintToken, normalizePem, parseConfig, writeToken } from "./mint-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
const ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_REPOSITORIES: "homelab,homelab-apps",
  TOKEN_FILE: "/run/renovate-token/token",
};
const okResponse = (body: unknown) =>
  ({ ok: true, status: 201, json: async () => body }) as unknown as Response;

describe("appJwt", () => {
  it("is an RS256 JWT for the App, backdated 60 s and valid for under 10 minutes", () => {
    const jwt: string = appJwt("123", privateKey, 1_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" });
    const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
    expect(verify.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});

describe("parseConfig", () => {
  it("reads ids, key, repositories and token file from the environment", () => {
    expect(parseConfig(ENV)).toEqual({
      appId: "123",
      installationId: "456",
      privateKey,
      repositories: ["homelab", "homelab-apps"],
      tokenFile: "/run/renovate-token/token",
      apiUrl: "https://api.github.com",
    });
  });

  it("rejects missing or non-numeric ids without echoing the private key", () => {
    expect(() => parseConfig({ ...ENV, GITHUB_APP_ID: "" })).toThrow(/GITHUB_APP_ID/);
    expect(() => parseConfig({ ...ENV, GITHUB_APP_INSTALLATION_ID: "1/../x" })).toThrow(
      /GITHUB_APP_INSTALLATION_ID/
    );
    expect(() => parseConfig({ ...ENV, GITHUB_APP_PRIVATE_KEY: "" })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/
    );
    try {
      parseConfig({ ...ENV, GITHUB_APP_ID: "x" });
    } catch (e) {
      expect(String(e)).not.toContain("PRIVATE KEY-----");
    }
  });
});

describe("mintToken", () => {
  it("posts the App JWT to the installation's access_tokens endpoint, scoped to the repositories", async () => {
    const fetch = vi.fn(async () => okResponse({ token: "ghs_abc", expires_at: "2026-01-01" }));
    const config = parseConfig(ENV);
    const result = await mintToken(config, fetch, 1_000_000);
    expect(result).toEqual({ token: "ghs_abc", expiresAt: "2026-01-01" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${appJwt("123", privateKey, 1_000_000)}`);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(JSON.parse(init.body as string)).toEqual({ repositories: ["homelab", "homelab-apps"] });
  });

  it("reports GitHub's error status and message, not the JWT", async () => {
    const fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ message: "A JSON web token could not be decoded" }),
        }) as unknown as Response
    );
    const error = await mintToken(parseConfig(ENV), fetch, 1_000_000).catch((e: Error) => e);
    expect(String(error)).toContain("401");
    expect(String(error)).toContain("could not be decoded");
    expect(String(error)).not.toContain(appJwt("123", privateKey, 1_000_000));
  });

  it("rejects a response without a token", async () => {
    const fetch = vi.fn(async () => okResponse({ message: "odd" }));
    await expect(mintToken(parseConfig(ENV), fetch, 1_000_000)).rejects.toThrow(/no token/);
  });
});

describe("writeToken", () => {
  it("writes only the token, readable by the owner only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "renovate-token-")), "token");
    writeToken(file, "ghs_abc");
    expect(readFileSync(file, "utf8")).toBe("ghs_abc");
    expect(statSync(file).mode & 0o777).toBe(0o400);
  });
});

describe("main", () => {
  it("writes the token and logs only its expiry", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "renovate-token-")), "token");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => okResponse({ token: "ghs_secret", expires_at: "T1" }));
    expect(await main({ ...ENV, TOKEN_FILE: file }, fetch)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("ghs_secret");
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("T1");
    expect(logged).not.toContain("ghs_secret");
    log.mockRestore();
  });

  it("fails with exit code 1 and a message without secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await main(ENV, fetch)).toBe(1);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("network down");
    expect(logged).not.toContain("PRIVATE KEY");
    log.mockRestore();
  });
});

describe("config.js (Renovate global config)", () => {
  it("sets token from the token file, trimmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renovate-token-"));
    const file = join(dir, "token");
    writeToken(file, "ghs_fromfile\n");
    const source = readFileSync(join(__dirname, "config.js"), "utf8");
    const module = { exports: {} as { token?: string } };
    new Function("module", "require", "process", source)(module, require, {
      env: { RENOVATE_TOKEN_FILE: file },
    });
    expect(module.exports).toEqual({ token: "ghs_fromfile" });
  });
});

describe("running as a script", () => {
  it("runs main when started through a symlink, as Kubernetes mounts ConfigMap files", () => {
    // ConfigMap volumes: /scripts/mint-token.mjs -> ..data/mint-token.mjs. Node resolves the symlink for
    // import.meta.url but not for process.argv[1]; the entry check must still match.
    const dir = mkdtempSync(join(tmpdir(), "mint-link-"));
    mkdirSync(join(dir, "..data"));
    copyFileSync(
      new URL("./mint-token.mjs", import.meta.url),
      join(dir, "..data", "mint-token.mjs")
    );
    symlinkSync(join("..data", "mint-token.mjs"), join(dir, "mint-token.mjs"));
    const r = spawnSync(process.execPath, [join(dir, "mint-token.mjs")], {
      env: {},
      encoding: "utf8",
    });
    // Without configuration main() must run and fail loudly, not exit 0 in silence.
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not mint the GitHub App installation token");
  });
});

describe("normalizePem", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const signs = (key: string) => {
    const jwt = appJwt("12345", normalizePem(key), 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    return createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s, "base64url"));
  };

  it("leaves a well-formed key as it is", () => {
    expect(normalizePem(privateKey)).toBe(privateKey);
    expect(signs(privateKey)).toBe(true);
  });

  it("rebuilds a key whose line breaks became spaces (one line, as stored in ESC)", () => {
    expect(signs(privateKey.trim().replace(/\n/g, " "))).toBe(true);
  });

  it("rebuilds a key whose line breaks are literal \\n", () => {
    expect(signs(privateKey.trim().replace(/\n/g, "\\n"))).toBe(true);
  });
});
