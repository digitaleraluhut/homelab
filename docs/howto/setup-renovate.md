# Set up self-hosted Renovate

Decision and rules: issue #100. Renovate runs as a nightly CronJob (`renovate` namespace),
defined in `packages/core/infrastructure/src/renovate/`. Behaviour is in `renovate.json`
per repository.

## One-time steps (owner)

1. Create a GitHub App `digitaleraluhut-renovate` in the organization. Repository
   permissions: Contents, Pull requests, Issues, Workflows (all read/write), Checks and
   Commit statuses (read), Metadata (read). No webhook needed.
2. Install it on `homelab`, `homelab-apps`, `local-ai`, `homelab-wiki`.
3. Store the App's credentials in the ESC environment of the cluster. The App id is on the
   App's settings page, the installation id is the number at the end of the installation's
   URL (organization settings → GitHub Apps → Configure), the private key is generated on the
   App's settings page (PEM file):
   ```bash
   pulumi env set mrsimpson/homelab/dev renovate-app-id <app-id> --string
   pulumi env set mrsimpson/homelab/dev renovate-installation-id <installation-id> --string
   pulumi env set mrsimpson/homelab/dev renovate-app-private-key --secret --file <key>.pem
   ```
   Delete the local PEM file afterwards. The ExternalSecret `renovate-github-app` syncs
   hourly; to sync at once:
   ```bash
   kubectl -n renovate annotate externalsecret renovate-github-app force-sync=$(date +%s) --overwrite
   kubectl -n renovate get externalsecret renovate-github-app   # STATUS SecretSynced
   ```
4. Merge the PR; `deploy-homelab-infra` creates the namespace, ExternalSecret and CronJob.
5. Check once:
   ```bash
   kubectl -n renovate create job --from=cronjob/renovate renovate-test
   kubectl -n renovate logs job/renovate-test -c mint-token   # "token written, expires at ..."
   kubectl -n renovate logs job/renovate-test -c renovate
   kubectl -n renovate delete job renovate-test
   ```

## How the token reaches Renovate

Renovate does not mint GitHub App tokens; it needs an installation token (`ghs_…`, valid one
hour) as `token` / `RENOVATE_TOKEN`
([docs](https://docs.renovatebot.com/modules/platform/github/#running-as-a-github-app)).
Each run therefore starts with the init container `mint-token` (`mint-token.mjs`, plain Node
in the Renovate image): it signs a JWT with the App's private key, exchanges it for an
installation token limited to the repositories above, and writes only the token to an
in-memory volume (mode 0400). The `renovate` container gets no App secret; its global config
file `config.js` (`RENOVATE_CONFIG_FILE`) reads the token from that file. A run lasts at most
an hour (`activeDeadlineSeconds`), as long as the token is valid.

## Marking versions for the custom managers

```ts
// renovate: helm-chart repo=https://charts.jetstack.io chart=cert-manager
version: "v1.14.0",
```
Images: put `// renovate: image` on the line above the one with `"name:tag"` or
`"name:tag@sha256:…"`; with a digest, Renovate updates both.
Existing pins get these comments in a follow-up, one area at a time.

## Open points
- Settled: the Renovate CLI does not mint installation tokens; the init container does (above).
- Renovate's docs list more App permissions than step 1 (Checks and Commit statuses
  read + write; Administration, Dependabot alerts, Members read). Proposal: add them only if a
  run reports missing permissions.
- Auto-merge needs the black-box tests of #100 as required checks; until then nothing
  auto-merges (homelab always needs owner approval).
