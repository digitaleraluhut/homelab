# How to Expose a Web App

## Goal

Make a containerized web application accessible from the internet via HTTPS, with automatic TLS, DNS, and optional authentication.

## Prerequisites

- Cluster set up (see [setup-cluster.md](setup-cluster.md))
- Container image (from Docker Hub, GHCR, or your own registry)
- Domain name (apps use subdomains of your configured homelab domain)

## Steps

### 1. Create the App Package

```bash
mkdir -p packages/demo-apps/my-app/src
```

Create `packages/demo-apps/my-app/package.json`:

```json
{
  "name": "@mrsimpson/homelab-app-my-app",
  "version": "0.1.0",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@mrsimpson/homelab-config": "*",
    "@mrsimpson/homelab-core-components": "*"
  },
  "peerDependencies": {
    "@pulumi/pulumi": "^3.137.0",
    "@pulumi/kubernetes": "^4.0.0"
  }
}
```

Create `packages/demo-apps/my-app/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

### 2. Write the App Module

Create `packages/demo-apps/my-app/src/index.ts`:

```typescript
import { homelabConfig } from "@mrsimpson/homelab-config";
import type { HomelabContext, ExposedWebApp } from "@mrsimpson/homelab-core-components";
import * as pulumi from "@pulumi/pulumi";

export function createMyApp(homelab: HomelabContext): {
  app: ExposedWebApp;
  url: pulumi.Output<string>;
} {
  const domain = pulumi.interpolate`my-app.${homelabConfig.domain}`;

  const app = homelab.createExposedWebApp("my-app", {
    image: "nginxinc/nginx-unprivileged:alpine",
    domain,
    port: 8080,
  });

  return { app, url: pulumi.interpolate`https://${domain}` };
}
```

`homelab.createExposedWebApp()` injects shared infrastructure (Cloudflare DNS, TLS, Gateway API, External Secrets) automatically — you only specify what's unique to your app.

### 3. Wire into the Root Stack

Edit `src/index.ts`:

```typescript
import { createMyApp } from "@mrsimpson/homelab-app-my-app";

const myApp = createMyApp(homelab);
export const myAppUrl = myApp.url;
```

Add the workspace dependency to root `package.json`:

```json
"dependencies": {
  "@mrsimpson/homelab-app-my-app": "*"
}
```

### 4. Deploy

```bash
npm install   # resolve workspace link
pulumi up
```

## What Gets Created

`ExposedWebApp` creates these resources automatically:

1. **Namespace** — with Pod Security Standards labels (unless you pass a pre-created one)
2. **Deployment** — runs your container with security hardening (non-root, drop ALL caps, seccomp)
3. **Service** — ClusterIP, maps port 80 → your container port
4. **Route** — HTTPRoute (Gateway API) or IngressRoute[] (Traefik CRD), depending on auth mode
5. **DNS record** — Cloudflare CNAME pointing to the Cloudflare Tunnel
6. **ExternalSecret** — GHCR pull credentials (when `imagePullSecrets` references `ghcr-pull-secret`)
7. **PVC** — persistent storage (when `storage` is set)

## Authentication

Three modes are available via the `auth` field:

### No auth (default)

```typescript
homelab.createExposedWebApp("my-app", {
  image: "nginx:alpine",
  domain,
  port: 80,
  // auth defaults to AuthType.NONE — public access
});
```

Uses Gateway API HTTPRoute.

### Authelia forward auth

```typescript
import { AuthType } from "@mrsimpson/homelab-core-components";

homelab.createExposedWebApp("my-app", {
  image: "nginx:alpine",
  domain,
  port: 80,
  auth: AuthType.FORWARD,
});
```

Uses Gateway API HTTPRoute with a ForwardAuth middleware pointing to Authelia. Access is controlled via Authelia policies. See [use-forward-auth.md](use-forward-auth.md).

### OAuth2-Proxy (GitHub OAuth)

```typescript
import { AuthType } from "@mrsimpson/homelab-core-components";

homelab.createExposedWebApp("my-app", {
  image: "nginx:alpine",
  domain,
  port: 80,
  auth: AuthType.OAUTH2_PROXY,
  oauth2Proxy: { group: "users" },
});
```

Uses Traefik IngressRoutes with a ForwardAuth → Errors → Chain middleware stack. Authenticates against the centralized oauth2-proxy deployment (GitHub OAuth). Access is controlled by email allowlists per group — see [manage-access-control.md](manage-access-control.md) and [OAUTH2_PROXY.md](../OAUTH2_PROXY.md).

## Common Options

```typescript
homelab.createExposedWebApp("my-app", {
  // Required
  image: "my-image:latest",
  domain: pulumi.interpolate`app.${homelabConfig.domain}`,
  port: 8080,

  // Replicas
  replicas: 2,

  // Persistent storage
  storage: { size: "10Gi", mountPath: "/data", storageClass: "longhorn" },

  // Stop the old pod before starting the new one (single-writer apps, ReadWriteOnce volumes)
  strategy: "Recreate",

  // HTTP/2 without TLS (h2c) from Traefik to the pod, e.g. gRPC or Zitadel (see below)
  backendProtocol: "h2c",

  // Path prefixes on the app's host to other Services in the namespace (see below)
  extraRoutes: [{ pathPrefix: "/ui/v2/login", serviceName: "my-app-login", servicePort: 3000 }],

  // Resources
  resources: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },

  // Environment variables
  env: [{ name: "DATABASE_URL", value: "postgres://..." }],

  // Container overrides
  command: ["/bin/sh"],
  args: ["-c", "my-entrypoint.sh"],

  // Extra volumes (ConfigMaps, hostPath, etc.)
  extraVolumes: [{ name: "cfg", configMap: { name: "my-config" } }],
  extraVolumeMounts: [{ name: "cfg", mountPath: "/etc/app" }],

  // Init containers
  initContainers: [{ name: "migrate", image: "my-app:latest", command: ["migrate"] }],

  // Service account (must already exist in the namespace)
  serviceAccountName: "my-app",

  // Health probes
  probes: {
    readinessProbe: { httpGet: { path: "/healthz", port: 8080 } },
    livenessProbe: { httpGet: { path: "/healthz", port: 8080 } },
  },

  // Node pinning (required for hostPath volumes)
  nodeSelector: { "kubernetes.io/hostname": "my-node" },

  // Private registry
  imagePullSecrets: [{ name: "ghcr-pull-secret" }],

  // Security
  securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },

  // Pre-created namespace (skip auto-creation)
  namespace: myNamespace,
});
```

## HTTP/2 to the backend (h2c)

Some apps need HTTP/2 between the proxy and the pod, for example gRPC services or Zitadel, which serves its APIs over gRPC and needs HTTP/2 behind a reverse proxy ([Zitadel: HTTP/2](https://zitadel.com/docs/self-hosting/manage/http2)). Set `backendProtocol: "h2c"`. The default is `"http"` (HTTP/1.1), and apps that do not set the option are unchanged.

| Routing | What the option sets | Read by Traefik |
|---|---|---|
| HTTPRoute (`AuthType.NONE`, `AuthType.FORWARD`) | `appProtocol: kubernetes.io/h2c` on the Service port | Gateway API provider, **from Traefik v3.2** |
| IngressRoute (`AuthType.OAUTH2_PROXY`) | `scheme: h2c` on the app's IngressRoute service (and the Service's `appProtocol`) | Kubernetes CRD provider (v3.1 too) |

> **Traefik version.** The cluster runs Traefik v3.1.5 (chart 32.1.0, `packages/core/infrastructure/src/traefik-gateway`). Its Gateway API provider ignores `appProtocol` and talks HTTP/1.1 to every HTTPRoute backend. The provider reads `kubernetes.io/h2c` only from Traefik v3.2.0 on (`getProtocol` in `pkg/provider/kubernetes/gateway/httproute.go`). Until Traefik is upgraded, h2c works only with `AuthType.OAUTH2_PROXY`.

## Path prefixes to other services (`extraRoutes`)

Some apps consist of more than one service on one host. Zitadel v4, for example, serves its Login V2 as a separate service at `https://id.<domain>/ui/v2/login`, while everything else on the host goes to the core (the [official chart](https://github.com/zitadel/zitadel-charts/blob/main/charts/zitadel/templates/httproute_login.yaml) does this with an HTTPRoute path prefix). Apps do not create their own routes, so `ExposedWebApp` does it:

```typescript
// The app creates the second Deployment and Service in its namespace ...
const loginService = new k8s.core.v1.Service("zitadel-login", { /* port 3000 → the login pod */ });

// ... and the component routes the prefix to it.
homelab.createExposedWebApp("zitadel", {
  // ...
  extraRoutes: [
    { pathPrefix: "/ui/v2/login", serviceName: loginService.metadata.name, servicePort: 3000 },
  ],
});
```

| | HTTPRoute (`AuthType.NONE`, `AuthType.FORWARD`) | IngressRoute (`AuthType.OAUTH2_PROXY`) |
|---|---|---|
| What it adds | one rule per prefix, before the app's `/` rule | one route `Host(...) && PathPrefix(...)` per prefix in the app's IngressRoute |
| Which wins | the longest `PathPrefix` across rules (Gateway API precedence) | Traefik's default priority, the rule's length: above the catch-all (priority 1), longest prefix first |
| Auth | the same Authelia filters as the app | the same OAuth2 middleware chain as the app |
| `backendProtocol: "h2c"` | no effect: Traefik reads `appProtocol: kubernetes.io/h2c` from the Service, which the app sets | `scheme: h2c` on the route's service |

- The extra paths always carry the app's auth: they are on the same host, and a protected app must not get public holes by accident.
- `pathPrefix` starts with `/`, is not `/` itself (that is the app) and has no wildcards, `//`, `/./` or `/../`; the component refuses anything else.
- Matching differs in one detail: Gateway API matches whole path segments (`/ui` matches `/ui/x`, not `/uix`), a Traefik `PathPrefix` matches characters. Prefer prefixes that end at a segment boundary in the app anyway.
- Without `extraRoutes` the routes are unchanged.

## Troubleshooting

### 502 Bad Gateway

```bash
kubectl get pods -n my-app
kubectl logs -n my-app deployment/my-app
```

Common causes: app not listening on the specified port, app crashed, container image wrong.

### 404 Not Found

Check the route was created:

```bash
# For Gateway API (AuthType.NONE or AuthType.FORWARD)
kubectl get httproute -n my-app

# For OAuth2-Proxy (AuthType.OAUTH2_PROXY)
kubectl get ingressroute -n my-app
```

### DNS Not Resolving

```bash
dig app.yourdomain.com
```

DNS propagation can take 30–120 seconds. Verify the Cloudflare DNS record exists in the dashboard.

## Next Steps

- [Add OAuth Protection](add-oauth-protection.md) — protect your app with GitHub OAuth
- [Set Up Persistent Storage](setup-persistent-storage.md) — configure storage for stateful apps
- [Deploy a Database](deploy-database.md) — add a database to your app
