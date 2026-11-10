# Set up self-hosted Renovate

Decision and rules: issue #100. Renovate runs as a nightly CronJob (`renovate` namespace),
defined in `packages/core/infrastructure/src/renovate/`. Behaviour is in `renovate.json`
per repository.

## One-time steps (owner)

1. Create a GitHub App `digitaleraluhut-renovate` in the organization. Repository
   permissions: Contents, Pull requests, Issues, Workflows (all read/write), Checks and
   Commit statuses (read), Metadata (read). No webhook needed.
2. Install it on `homelab`, `homelab-apps`, `local-ai`, `homelab-wiki`.
3. Store in the Pulumi ESC environment of the cluster: `renovate-app-id`,
   `renovate-installation-id`, `renovate-app-private-key`.
4. Merge the PR; `deploy-homelab-infra` creates the namespace, ExternalSecret and CronJob.
5. Check once: `kubectl -n renovate create job --from=cronjob/renovate renovate-test`, then the logs.

## Marking versions for the custom managers

```ts
// renovate: helm-chart repo=https://charts.jetstack.io chart=cert-manager
version: "v1.14.0",
```
Images: put `// renovate: image` on the line above `image: "name:tag"`.
Existing pins get these comments in a follow-up, one area at a time.

## Open points
- The CronJob uses Renovate's `RENOVATE_GITHUB_APP_*` variables. Not yet verified that the
  CLI mints the installation token itself; if not, an init container must do it.
- Auto-merge needs the black-box tests of #100 as required checks; until then nothing
  auto-merges (homelab always needs owner approval).
