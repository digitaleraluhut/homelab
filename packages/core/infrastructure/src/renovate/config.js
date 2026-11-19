// Renovate global config (RENOVATE_CONFIG_FILE). Reads the GitHub App installation token
// that the init container minted (mint-token.mjs), so it never appears in the pod spec.
// `token` is the config form of RENOVATE_TOKEN:
// https://docs.renovatebot.com/modules/platform/github/#running-as-a-github-app
const fs = require("node:fs");

const tokenFile = process.env.RENOVATE_TOKEN_FILE ?? "/run/renovate-token/token";

module.exports = { token: fs.readFileSync(tokenFile, "utf8").trim() };
