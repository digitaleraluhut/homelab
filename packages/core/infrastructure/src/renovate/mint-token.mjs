// Mints a GitHub App installation token for Renovate and writes only the token to a file.
// Runs as the init container of the renovate CronJob (plain Node, no dependencies).
// Renovate needs an installation token (ghs_..., valid 1 hour) and does not mint it itself:
// https://docs.renovatebot.com/modules/platform/github/#running-as-a-github-app
//
// Environment: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PEM),
// GITHUB_REPOSITORIES (comma-separated names, the token is limited to them), TOKEN_FILE,
// optional GITHUB_API_URL. Neither the private key nor the token is ever logged.
import { createSign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const b64url = (data) => Buffer.from(data).toString("base64url");

/** RS256 JWT for the App: backdated 60 s against clock drift, valid 9 minutes (max is 10). */
export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

export function parseConfig(env) {
  const numeric = (name) => {
    const value = (env[name] ?? "").trim();
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric id`);
    return value;
  };
  const appId = numeric("GITHUB_APP_ID");
  const installationId = numeric("GITHUB_APP_INSTALLATION_ID");
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (!privateKey.trim()) throw new Error("GITHUB_APP_PRIVATE_KEY is empty");
  const tokenFile = env.TOKEN_FILE ?? "";
  if (!tokenFile) throw new Error("TOKEN_FILE is not set");
  const repositories = (env.GITHUB_REPOSITORIES ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return {
    appId,
    installationId,
    privateKey,
    repositories,
    tokenFile,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
  };
}

export async function mintToken(config, fetchImpl = fetch, now = undefined) {
  const jwt = appJwt(config.appId, config.privateKey, now);
  const body = config.repositories.length > 0 ? { repositories: config.repositories } : {};
  const response = await fetchImpl(
    `${config.apiUrl}/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "homelab-renovate-mint-token",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${data.message ?? "no message"}`);
  }
  if (typeof data.token !== "string" || !data.token) {
    throw new Error("GitHub API returned no token");
  }
  return { token: data.token, expiresAt: data.expires_at };
}

/** Writes only the token, readable by its owner only; fails if the file already exists. */
export function writeToken(file, token) {
  writeFileSync(file, token, { mode: 0o400, flag: "wx" });
}

export async function main(env = process.env, fetchImpl = fetch) {
  try {
    const config = parseConfig(env);
    const { token, expiresAt } = await mintToken(config, fetchImpl);
    writeToken(config.tokenFile, token);
    console.error(`GitHub App installation token written, expires at ${expiresAt}`);
    return 0;
  } catch (error) {
    console.error(`Could not mint the GitHub App installation token: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
