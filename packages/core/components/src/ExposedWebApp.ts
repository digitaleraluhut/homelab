import * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * ExposedWebApp — reusable Pulumi component for deploying web apps with secure internet exposure.
 *
 * Handles the full stack: Deployment → Service → HTTPRoute/IngressRoute → TLS → DNS.
 *
 * ## Authentication modes
 * - `AuthType.NONE`         — no auth, public access
 * - `AuthType.FORWARD`      — Authelia forward-auth via Traefik ForwardAuth middleware
 * - `AuthType.OAUTH2_PROXY` — GitHub OAuth via the shared oauth2-proxy IngressRoute
 *
 * ## What gets created automatically
 * - `Namespace` (with Pod Security Standards labels, unless you pass your own)
 * - `Deployment` + `Service` (ClusterIP)
 * - `HTTPRoute` or `IngressRoute[]` depending on auth mode
 * - Optional `PersistentVolumeClaim` (when `storage` is set)
 * - Optional Cloudflare DNS `Record` (when `cloudflare` is set)
 * - Optional `ExternalSecret` for GHCR pull credentials (when `imagePullSecrets` references `ghcr-pull-secret`)
 *
 * ## Key options
 *
 * ### Container overrides
 * - `command` / `args` — override entrypoint / arguments (e.g. `args: ["web", "--port", "4096"]`)
 *
 * ### Extra volumes
 * - `extraVolumes` / `extraVolumeMounts` — inject additional volumes (ConfigMaps, hostPath, etc.)
 *   alongside the built-in storage PVC mount.
 *
 * ### Node pinning
 * - `nodeSelector` — pin the pod to specific node(s) by label.
 *   **Required when using hostPath volumes**, which are node-local by definition.
 *   Example: `{ "kubernetes.io/hostname": "flinker" }`
 *
 * ### Security context
 * - `securityContext.runAsUser/Group/fsGroup` — UID/GID for the container and volume ownership.
 * - `securityContext.allowRoot` — set to `true` only when the image genuinely requires UID 0.
 *   Automatically relaxes the namespace Pod Security Standard from `restricted` to `baseline`.
 *   Also disables `runAsNonRoot` on the pod and container security contexts.
 *   Prefer fixing the image to run as non-root instead of using this flag.
 * - `extraVolumes` with `hostPath` — automatically relaxes the namespace PSS to `privileged`
 *   (the only level that permits hostPath volumes per the Kubernetes PSS spec).
 *   The pod itself still runs as non-root with all capabilities dropped.
 *
 * ### Service account
 * - `serviceAccountName` — set the pod's ServiceAccount (must already exist in the namespace).
 *   Useful when the app needs RBAC permissions (e.g. managing pods via the K8s API).
 *
 * ### Extra routes (path prefixes to other services)
 * - `extraRoutes` — send path prefixes on the app's host to other Services in the app's namespace
 *   (e.g. Zitadel's Login V2 at `/ui/v2/login`). The app creates those Services; the component
 *   routes to them with the same auth as the app. Apps must not create their own routes.
 *
 * ### Health probes
 * - `probes.readinessProbe` / `probes.livenessProbe` — standard Kubernetes probe objects
 *   applied to the main app container. Omit to use no probes (Kubernetes default).
 *
 * ## OAuth2-Proxy middleware naming
 *
 * When `auth` is `AuthType.OAUTH2_PROXY`, three Traefik middlewares are created in the
 * app's namespace with deterministic names:
 * - `<name>-oauth2-forwardauth` — ForwardAuth against the oauth2-proxy root (static upstream: 202 with a
 *   session, 302 to the sign-in without one; the app's own 401s pass through)
 * - `<name>-oauth2-chain` — the chain apps reference; holds the forwardauth
 *
 * Apps that need **additional IngressRoutes** (e.g. wildcard subdomain routes) can
 * reference the chain middleware by name to share the same auth flow:
 * ```yaml
 * middlewares:
 *   - name: <name>-oauth2-chain
 *     namespace: <app-namespace>
 * ```
 *
 * ## Example
 * ```typescript
 * homelab.createExposedWebApp("blog", {
 *   image: "ghost:5",
 *   domain: pulumi.interpolate`blog.${homelabConfig.domain}`,
 *   port: 2368,
 *   auth: AuthType.OAUTH2_PROXY,
 *   storage: { size: "10Gi", mountPath: "/var/lib/ghost/content" },
 *   nodeSelector: { "kubernetes.io/hostname": "flinker" },
 *   extraVolumes: [{ name: "cfg", configMap: { name: "blog-config" } }],
 *   extraVolumeMounts: [{ name: "cfg", mountPath: "/etc/blog" }],
 * });
 * ```
 */

/**
 * Authentication type for ExposedWebApp
 */
export enum AuthType {
  /** No authentication required */
  NONE = "none",
  /** Authelia forward authentication via Traefik ForwardAuth middleware */
  FORWARD = "forward",
  /** OAuth2-Proxy authentication via GitHub OAuth (uses IngressRoute instead of HTTPRoute) */
  OAUTH2_PROXY = "oauth2",
}

export interface StorageConfig {
  size: string;
  mountPath: string;
  storageClass?: string;
}

export interface CloudflareConfig {
  /** Cloudflare Zone ID for creating DNS records */
  zoneId: string | pulumi.Output<string>;
  /** CNAME value for DNS record (usually the Cloudflare Tunnel hostname) */
  tunnelCname: string | pulumi.Output<string>;
}

export interface TLSConfig {
  /** ClusterIssuer resource for automatic TLS certificate provisioning */
  clusterIssuer?: k8s.apiextensions.CustomResource;
  /** Name of the ClusterIssuer (if not providing the resource) */
  clusterIssuerName?: string | pulumi.Output<string>;
}

export interface GatewayApiConfig {
  /** Gateway class name (defaults to "traefik") */
  gatewayClass?: string;
  /** Gateway name (defaults to "homelab-gateway") */
  gatewayName?: string;
  /** Gateway namespace (defaults to "traefik-system") */
  gatewayNamespace?: string;
  /** ForwardAuth middleware name for authentication (defaults to "authelia-forwardauth") */
  forwardAuthMiddleware?: string;
  /** Gateway controller resource to depend on */
  controller?: pulumi.Resource;
}

export interface ExternalSecretsConfig {
  /** External Secrets Operator resource to depend on */
  operator?: pulumi.Resource;
  /** ClusterSecretStore name (defaults to "pulumi-esc") */
  storeName?: string;
}

export interface OAuth2ProxyConfig {
  /** Which oauth2-proxy group to use (defaults to "users") */
  group?: string;
  /** Namespace where oauth2-proxy is deployed (defaults to "oauth2-proxy") */
  namespace?: string;
}

/**
 * A path prefix on the app's host that goes to another Service in the app's namespace.
 * The app creates the Service; the component only routes to it, with the app's auth.
 */
export interface ExtraRoute {
  /** Path prefix, e.g. `/ui/v2/login`. Starts with `/`, is not `/` itself, no wildcards. */
  pathPrefix: string;
  /** Name of the Service, in the app's namespace */
  serviceName: pulumi.Input<string>;
  /** Port of the Service */
  servicePort: number;
  /**
   * Protocol between Traefik and that Service. Default `"http"`. `"h2c"` sets `scheme: h2c` on the
   * IngressRoute service (OAuth2-Proxy mode). For HTTPRoutes Traefik reads the protocol from the
   * Service itself: the app sets `appProtocol: kubernetes.io/h2c` on its Service port.
   */
  backendProtocol?: "http" | "h2c";
}

/** Refuses path prefixes that would not route as a plain prefix (see {@link ExtraRoute}). */
function validateExtraRoutes(name: string, routes: ExtraRoute[]): void {
  for (const { pathPrefix } of routes) {
    const problem = !pathPrefix.startsWith("/")
      ? "must start with /"
      : pathPrefix === "/"
        ? "must not be / (that is the app itself)"
        : pathPrefix.includes("*")
          ? "must not contain wildcards"
          : /\/\/|\/\.\.?(\/|$)/.test(pathPrefix)
            ? "must not contain //, /./ or /../"
            : undefined;
    if (problem) {
      throw new Error(`ExposedWebApp ${name}: extraRoutes pathPrefix "${pathPrefix}" ${problem}`);
    }
  }
}

export interface ExposedWebAppArgs {
  /** Container image to deploy */
  image: string | pulumi.Output<string>;
  /** Fully qualified domain name */
  domain: string | pulumi.Output<string>;
  /** Container port */
  port: number;
  /** Number of replicas (defaults to 1) */
  replicas?: number;

  /**
   * Deployment strategy. Default: Kubernetes' rolling update (new pod first, then the old one stops).
   * Use `"Recreate"` for apps that cannot run two pods at once: a ReadWriteOnce data volume, or a
   * lock in it (Gitea's queue database fails with "unable to lock level db" during a rollout).
   */
  strategy?: "RollingUpdate" | "Recreate";

  /**
   * Kubernetes injects environment variables for every Service in the namespace (service links,
   * e.g. `<SERVICE>_PORT=tcp://…`). Set `false` for apps that read every variable with their
   * prefix as configuration (Zitadel: a Service `zitadel` yields ZITADEL_PORT, which it misreads).
   * Unset keeps Kubernetes' default (on).
   */
  enableServiceLinks?: boolean;
  /**
   * Protocol between Traefik and the pod. Default `"http"` (HTTP/1.1).
   * `"h2c"` (HTTP/2 without TLS) is for apps that need HTTP/2 to the backend, e.g. gRPC or
   * Zitadel (gRPC APIs, zitadel.com/docs/self-hosting/manage/http2). It sets `appProtocol: kubernetes.io/h2c` on the
   * Service port (read by Traefik's Gateway API provider for HTTPRoutes, from Traefik v3.2) and
   * `scheme: h2c` on the app's IngressRoute service (OAuth2-Proxy mode).
   */
  backendProtocol?: "http" | "h2c";
  /**
   * Path prefixes on the app's host that go to other Services in the app's namespace, e.g.
   * Zitadel's Login V2 at `/ui/v2/login`. Same auth as the app; the longest prefix wins, `/` stays
   * with the app. Default: none (routes unchanged).
   */
  extraRoutes?: ExtraRoute[];
  /** Override the container entrypoint (maps to K8s container.command) */
  command?: string[];
  /** Container arguments (maps to K8s container.args) */
  args?: string[];
  /** Environment variables */
  env?: Array<{ name: string; value: string | pulumi.Output<string> }>;
  /** Inject all keys from Secrets or ConfigMaps as environment variables */
  envFrom?: Array<{
    secretRef?: { name: string | pulumi.Output<string> };
    configMapRef?: { name: string | pulumi.Output<string> };
    prefix?: string;
  }>;
  /** Authentication type (defaults to "none") */
  auth?: AuthType;
  /** Persistent storage configuration */
  storage?: StorageConfig;
  /** Resource requests and limits */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /** Tags for organizing resources */
  tags?: string[];
  /** ImagePullSecrets for private container registries (e.g., GHCR, ECR) */
  imagePullSecrets?: Array<{ name: string }>;
  /** Security context configuration for pod and container */
  securityContext?: {
    runAsUser?: number;
    runAsGroup?: number;
    fsGroup?: number;
    /**
     * Set to true only when the container image requires root (UID 0) to function.
     * This disables the `runAsNonRoot` enforcement on both the pod and container security
     * contexts, and relaxes the namespace Pod Security Standard to "baseline".
     * Use with caution — prefer fixing the image to run as non-root instead.
     */
    allowRoot?: boolean;
  };
  /** Optional pre-created namespace (if not provided, will create one) */
  namespace?: k8s.core.v1.Namespace;
  /**
   * Pin the pod to specific node(s) using Kubernetes nodeSelector labels.
   * Required when using hostPath volumes (which are node-local by definition).
   * Example: { "kubernetes.io/hostname": "flinker" }
   */
  nodeSelector?: Record<string, string>;
  /** Extra volumes to add to the pod spec (in addition to the optional storage PVC) */
  extraVolumes?: object[];
  /** Extra volume mounts to add to the app container (in addition to the optional storage mount) */
  extraVolumeMounts?: object[];
  /**
   * Init containers to run before the main app container starts.
   * Useful for seeding files into emptyDir volumes or other pre-start setup.
   * Each entry is a full Kubernetes container spec object.
   */
  initContainers?: object[];
  /**
   * Additional sidecar containers to run alongside the main app container.
   * Each entry is a full Kubernetes container spec object.
   * Sidecars share the pod's ServiceAccount, imagePullSecrets, and network namespace.
   * Useful for operator sidecars, log shippers, proxies, etc.
   */
  extraContainers?: object[];
  /** ServiceAccount name to set on the pod spec (must already exist in the namespace) */
  serviceAccountName?: string;
  /** Container probes for the main app container */
  probes?: {
    readinessProbe?: object;
    livenessProbe?: object;
  };

  // Infrastructure dependencies (all optional)
  /** Cloudflare DNS configuration */
  cloudflare?: CloudflareConfig;
  /** TLS/cert-manager configuration */
  tls?: TLSConfig;
  /** Gateway API configuration */
  gatewayApi?: GatewayApiConfig;
  /** External Secrets Operator configuration */
  externalSecrets?: ExternalSecretsConfig;
  /** OAuth2-Proxy configuration (required when auth is OAUTH2_PROXY) */
  oauth2Proxy?: OAuth2ProxyConfig;
}

export class ExposedWebApp extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  /** Route resource(s): single HTTPRoute (Authelia/NONE) or IngressRoute[] (OAuth2-Proxy) */
  public readonly route: k8s.apiextensions.CustomResource | k8s.apiextensions.CustomResource[];
  public readonly forwardAuthMiddleware?: k8s.apiextensions.CustomResource;
  public readonly dnsRecord?: cloudflare.Record;
  public readonly pvc?: k8s.core.v1.PersistentVolumeClaim;

  constructor(name: string, args: ExposedWebAppArgs, opts?: pulumi.ComponentResourceOptions) {
    const extraRoutes = args.extraRoutes ?? [];
    validateExtraRoutes(name, extraRoutes);
    super("homelab:ExposedWebApp", name, {}, opts);

    const childOpts = { parent: this };

    // Use provided namespace or create a new one
    // Pod Security Standard level for the namespace:
    // - "restricted": default, enforces non-root, no hostPath, etc.
    // - "baseline":   required when allowRoot is set (permits running as UID 0)
    // - "privileged": required when hostPath volumes are present (hostPath is
    //                 forbidden even in baseline per the K8s PSS spec)
    const hasHostPath = args.extraVolumes?.some(
      (v) => typeof v === "object" && v !== null && "hostPath" in v
    );
    const podSecurityLevel = hasHostPath
      ? "privileged"
      : args.securityContext?.allowRoot
        ? "baseline"
        : "restricted";
    const namespace =
      args.namespace ||
      new k8s.core.v1.Namespace(
        `${name}-ns`,
        {
          metadata: {
            name: name,
            labels: {
              app: name,
              environment: pulumi.getStack(),
              // Pod Security Standards — relaxed to "baseline" when the image requires root
              "pod-security.kubernetes.io/enforce": podSecurityLevel,
              "pod-security.kubernetes.io/audit": podSecurityLevel,
              "pod-security.kubernetes.io/warn": podSecurityLevel,
            },
          },
        },
        childOpts
      );
    this.namespace = namespace;

    // If imagePullSecrets are specified, automatically create ExternalSecrets
    // for common pull secret names (e.g. ghcr-pull-secret, dockerhub-pull-secret)
    const pullSecretResources: k8s.apiextensions.CustomResource[] = [];
    if (args.imagePullSecrets && args.externalSecrets) {
      const storeName = args.externalSecrets.storeName || "pulumi-esc";

      // Create dependencies for ExternalSecret
      const externalSecretDeps: pulumi.Resource[] = [namespace];
      if (args.externalSecrets.operator) {
        externalSecretDeps.push(args.externalSecrets.operator);
      }

      args.imagePullSecrets.forEach((pullSecret) => {
        // Only auto-create for known secret names to avoid creating unnecessary resources
        if (pullSecret.name === "ghcr-pull-secret") {
          pullSecretResources.push(
            new k8s.apiextensions.CustomResource(
              `${name}-ghcr-pull-secret`,
              {
                apiVersion: "external-secrets.io/v1beta1",
                kind: "ExternalSecret",
                metadata: {
                  name: "ghcr-pull-secret",
                  namespace: namespace.metadata.name,
                },
                spec: {
                  refreshInterval: "1h",
                  secretStoreRef: {
                    name: storeName,
                    kind: "ClusterSecretStore",
                  },
                  target: {
                    name: "ghcr-pull-secret",
                    creationPolicy: "Owner",
                    template: {
                      type: "kubernetes.io/dockerconfigjson",
                      data: {
                        ".dockerconfigjson": `{"auths":{"ghcr.io":{"username":"{{ .github_username }}","password":"{{ .github_token }}","auth":"{{ printf "%s:%s" .github_username .github_token | b64enc }}"}}}`,
                      },
                    },
                  },
                  data: [
                    {
                      secretKey: "github_username",
                      remoteRef: {
                        key: "github-username",
                      },
                    },
                    {
                      secretKey: "github_token",
                      remoteRef: {
                        key: "github-token",
                      },
                    },
                  ],
                },
              },
              { ...childOpts, dependsOn: externalSecretDeps }
            )
          );
        } else if (pullSecret.name === "dockerhub-pull-secret") {
          pullSecretResources.push(
            new k8s.apiextensions.CustomResource(
              `${name}-dockerhub-pull-secret`,
              {
                apiVersion: "external-secrets.io/v1beta1",
                kind: "ExternalSecret",
                metadata: {
                  name: "dockerhub-pull-secret",
                  namespace: namespace.metadata.name,
                },
                spec: {
                  refreshInterval: "1h",
                  secretStoreRef: {
                    name: storeName,
                    kind: "ClusterSecretStore",
                  },
                  target: {
                    name: "dockerhub-pull-secret",
                    creationPolicy: "Owner",
                    template: {
                      type: "kubernetes.io/dockerconfigjson",
                      data: {
                        ".dockerconfigjson": `{
  "auths": {
    "https://index.docker.io/v1/": {
      "username": "{{ .dockerhub_username }}",
      "password": "{{ .dockerhub_token }}",
      "auth": "{{ printf "%s:%s" .dockerhub_username .dockerhub_token | b64enc }}"
    }
  }
}`,
                      },
                    },
                  },
                  data: [
                    {
                      secretKey: "dockerhub_username",
                      remoteRef: {
                        key: "dockerhub-credentials/username",
                      },
                    },
                    {
                      secretKey: "dockerhub_token",
                      remoteRef: {
                        key: "dockerhub-credentials/token",
                      },
                    },
                  ],
                },
              },
              { ...childOpts, dependsOn: externalSecretDeps }
            )
          );
        }
      });
    }

    // Optional: Create PVC for persistent storage
    if (args.storage) {
      this.pvc = new k8s.core.v1.PersistentVolumeClaim(
        `${name}-pvc`,
        {
          metadata: {
            name: `${name}-storage`,
            namespace: namespace.metadata.name,
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            storageClassName: args.storage.storageClass || "local-path",
            resources: {
              requests: {
                storage: args.storage.size,
              },
            },
          },
        },
        childOpts
      );
    }

    // Main application container
    const appContainer: any = {
      name: "app",
      image: args.image,
      ports: [
        {
          containerPort: args.port,
          name: "http",
        },
      ],
      env: args.env || [],
      envFrom: args.envFrom || [],
      resources: args.resources || {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        // Only enforce runAsNonRoot when the image supports it (opt-out via allowRoot)
        ...(args.securityContext?.allowRoot ? {} : { runAsNonRoot: true }),
        capabilities: {
          drop: ["ALL"],
        },
        seccompProfile: {
          type: "RuntimeDefault",
        },
      },
    };

    // Add optional command / args overrides
    if (args.command) {
      appContainer.command = args.command;
    }
    if (args.args) {
      appContainer.args = args.args;
    }

    // Add optional probes
    if (args.probes?.readinessProbe) {
      appContainer.readinessProbe = args.probes.readinessProbe;
    }
    if (args.probes?.livenessProbe) {
      appContainer.livenessProbe = args.probes.livenessProbe;
    }

    // Build volume mounts: storage PVC mount + any extra mounts
    const volumeMounts: object[] = [];
    if (args.storage && this.pvc) {
      volumeMounts.push({
        name: "storage",
        mountPath: args.storage.mountPath,
      });
    }
    if (args.extraVolumeMounts) {
      volumeMounts.push(...args.extraVolumeMounts);
    }
    if (volumeMounts.length > 0) {
      appContainer.volumeMounts = volumeMounts;
    }

    // Build volumes list: storage PVC + any extra volumes
    const volumes: any[] = [];
    if (args.storage && this.pvc) {
      volumes.push({
        name: "storage",
        persistentVolumeClaim: {
          // The fixed name, not this.pvc.metadata.name: an output would make the Deployment
          // wait for the PVC, which on WaitForFirstConsumer classes binds only once a pod
          // uses it (deadlock). The pod waits for the claim by itself.
          claimName: `${name}-storage`,
        },
      });
    }
    if (args.extraVolumes) {
      volumes.push(...args.extraVolumes);
    }

    // Create Deployment
    // Build deployment dependencies - include pull secrets if we created them
    const deploymentDeps: pulumi.Resource[] = [namespace, ...pullSecretResources];

    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      {
        metadata: {
          name: name,
          namespace: namespace.metadata.name,
          labels: {
            app: name,
            environment: pulumi.getStack(),
          },
        },
        spec: {
          replicas: args.replicas || 1,
          ...(args.strategy ? { strategy: { type: args.strategy } } : {}),
          selector: {
            matchLabels: {
              app: name,
            },
          },
          template: {
            metadata: {
              labels: {
                app: name,
              },
            },
            spec: {
              ...(args.enableServiceLinks !== undefined
                ? { enableServiceLinks: args.enableServiceLinks }
                : {}),
              serviceAccountName: args.serviceAccountName,
              imagePullSecrets: args.imagePullSecrets,
              nodeSelector: args.nodeSelector,
              securityContext: {
                // Only enforce runAsNonRoot when the image supports it (opt-out via allowRoot)
                ...(args.securityContext?.allowRoot ? {} : { runAsNonRoot: true }),
                // When allowRoot is true, omit runAsUser/runAsGroup to let the image use its own UID
                ...(args.securityContext?.allowRoot
                  ? {}
                  : {
                      runAsUser: args.securityContext?.runAsUser || 1000,
                      runAsGroup: args.securityContext?.runAsGroup || 1000,
                    }),
                fsGroup: args.securityContext?.allowRoot
                  ? undefined
                  : args.securityContext?.fsGroup || 1000,
              },
              containers: [
                appContainer,
                ...((args.extraContainers ?? []) as k8s.types.input.core.v1.Container[]),
              ],
              initContainers: args.initContainers as
                | k8s.types.input.core.v1.Container[]
                | undefined,
              volumes: volumes.length > 0 ? volumes : undefined,
            },
          },
        },
      },
      { ...childOpts, dependsOn: deploymentDeps }
    );

    // Create Service
    const h2c = args.backendProtocol === "h2c";
    this.service = new k8s.core.v1.Service(
      `${name}-service`,
      {
        metadata: {
          name: name,
          namespace: namespace.metadata.name,
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: name,
          },
          ports: [
            {
              port: 80,
              targetPort: args.port,
              protocol: "TCP",
              name: "http",
              ...(h2c ? { appProtocol: "kubernetes.io/h2c" } : {}),
            },
          ],
        },
      },
      { ...childOpts, dependsOn: [this.deployment] }
    );

    // --- Routing & Authentication ---
    // OAuth2-Proxy uses IngressRoute (Traefik CRD) for reliable cross-namespace support
    // Authelia and NONE use Gateway API HTTPRoute

    if (args.auth === AuthType.OAUTH2_PROXY) {
      // --- OAuth2-Proxy: IngressRoute-based routing ---
      const oauth2Group = args.oauth2Proxy?.group || "users";
      const oauth2Namespace = args.oauth2Proxy?.namespace || "oauth2-proxy";
      // The proxy's root, served by its static upstream (homelab#177): 202 with a session, otherwise a
      // 302 to the sign-in, built from the X-Forwarded-* headers. No errors middleware is needed, so the
      // app's own 401s (e.g. a Basic auth challenge) reach the browser unchanged.
      // Source: oauth2-proxy docs, configuration/integrations/traefik.md, "ForwardAuth with static upstreams".
      const oauth2ProxyServiceAddress = `http://oauth2-proxy-${oauth2Group}.${oauth2Namespace}.svc.cluster.local/`;

      // ForwardAuth middleware - checks the session and redirects to the sign-in without one
      this.forwardAuthMiddleware = new k8s.apiextensions.CustomResource(
        `${name}-oauth2-forwardauth`,
        {
          apiVersion: "traefik.io/v1alpha1",
          kind: "Middleware",
          metadata: {
            name: `${name}-oauth2-forwardauth`,
            namespace: namespace.metadata.name,
          },
          spec: {
            forwardAuth: {
              address: oauth2ProxyServiceAddress,
              trustForwardHeader: true,
              // CRITICAL: Forward Cookie header so oauth2-proxy can see the session
              authRequestHeaders: ["Cookie", "Authorization"],
              authResponseHeaders: [
                "X-Auth-Request-User",
                "X-Auth-Request-Email",
                "X-Auth-Request-Groups",
                "X-Auth-Request-Access-Token",
                "Set-Cookie",
              ],
            },
          },
        },
        { ...childOpts, dependsOn: [this.service] }
      );

      // Chain middleware: only the forwardAuth now; the name stays because apps reference it
      // (e.g. opencode-router's session subdomains).
      const chainMiddleware = new k8s.apiextensions.CustomResource(
        `${name}-oauth2-chain`,
        {
          apiVersion: "traefik.io/v1alpha1",
          kind: "Middleware",
          metadata: {
            name: `${name}-oauth2-chain`,
            namespace: namespace.metadata.name,
          },
          spec: {
            chain: {
              middlewares: [{ name: `${name}-oauth2-forwardauth` }],
            },
          },
        },
        {
          ...childOpts,
          dependsOn: [this.forwardAuthMiddleware],
        }
      );

      // IngressRoute 1: /oauth2/* → oauth2-proxy (unprotected, handles sign-in flow)
      const signinRoute = new k8s.apiextensions.CustomResource(
        `${name}-oauth2-signin-route`,
        {
          apiVersion: "traefik.io/v1alpha1",
          kind: "IngressRoute",
          metadata: {
            name: `${name}-oauth2-signin`,
            namespace: namespace.metadata.name,
          },
          spec: {
            // Use "web" entryPoint: Cloudflare terminates TLS, traffic arrives as HTTP
            entryPoints: ["web"],
            routes: [
              {
                match: pulumi.interpolate`Host(\`${args.domain}\`) && PathPrefix(\`/oauth2/\`)`,
                kind: "Rule",
                services: [
                  {
                    name: `oauth2-proxy-${oauth2Group}`,
                    namespace: oauth2Namespace,
                    port: 80,
                  },
                ],
              },
            ],
          },
        },
        { ...childOpts, dependsOn: [namespace] }
      );

      // IngressRoute 2: /* → app backend (protected by middleware chain)
      const appRoute = new k8s.apiextensions.CustomResource(
        `${name}-oauth2-app-route`,
        {
          apiVersion: "traefik.io/v1alpha1",
          kind: "IngressRoute",
          metadata: {
            name: `${name}-oauth2-app`,
            namespace: namespace.metadata.name,
          },
          spec: {
            entryPoints: ["web"],
            routes: [
              {
                match: pulumi.interpolate`Host(\`${args.domain}\`)`,
                kind: "Rule",
                middlewares: [
                  {
                    name: `${name}-oauth2-chain`,
                    namespace: namespace.metadata.name,
                  },
                ],
                services: [
                  {
                    name: this.service.metadata.name,
                    port: 80,
                    ...(h2c ? { scheme: "h2c" } : {}),
                  },
                ],
                priority: 1, // Lower priority than /oauth2/* route
              },
              // Extra path prefixes, behind the same chain: they are on the same protected host.
              // No explicit priority: Traefik's default is the rule's length, always above the
              // catch-all's 1, and the longest prefix wins among them (as in Gateway API).
              ...extraRoutes.map((r) => ({
                match: pulumi.interpolate`Host(\`${args.domain}\`) && PathPrefix(\`${r.pathPrefix}\`)`,
                kind: "Rule",
                middlewares: [
                  {
                    name: `${name}-oauth2-chain`,
                    namespace: namespace.metadata.name,
                  },
                ],
                services: [
                  {
                    name: r.serviceName,
                    port: r.servicePort,
                    ...(r.backendProtocol === "h2c" ? { scheme: "h2c" } : {}),
                  },
                ],
              })),
            ],
          },
        },
        {
          ...childOpts,
          dependsOn: [this.service, chainMiddleware, signinRoute],
        }
      );

      this.route = [signinRoute, appRoute];
    } else {
      // --- Authelia / NONE: Gateway API HTTPRoute ---

      const gatewayName = args.gatewayApi?.gatewayName || "homelab-gateway";
      const gatewayNamespace = args.gatewayApi?.gatewayNamespace || "traefik-system";

      // Build Gateway API dependencies
      const httpRouteDeps: pulumi.Resource[] = [this.service];
      if (args.gatewayApi?.controller) {
        httpRouteDeps.push(args.gatewayApi.controller);
      }
      if (args.tls?.clusterIssuer) {
        httpRouteDeps.push(args.tls.clusterIssuer);
      }

      // Create ForwardAuth middleware for Authelia
      if (args.auth === AuthType.FORWARD) {
        this.forwardAuthMiddleware = new k8s.apiextensions.CustomResource(
          `${name}-forwardauth`,
          {
            apiVersion: "traefik.io/v1alpha1",
            kind: "Middleware",
            metadata: {
              name: "forwardauth",
              namespace: namespace.metadata.name,
            },
            spec: {
              forwardAuth: {
                address: "http://authelia.authelia.svc.cluster.local:9091/api/authz/auth-request",
                trustForwardHeader: true,
                authRequestHeaders: [
                  "X-Original-URL",
                  "X-Original-Method",
                  "X-Forwarded-Host",
                  "X-Forwarded-Proto",
                  "X-Forwarded-Uri",
                  "Accept",
                  "Authorization",
                  "Cookie",
                ],
                authResponseHeaders: [
                  "Remote-User",
                  "Remote-Groups",
                  "Remote-Name",
                  "Remote-Email",
                ],
              },
            },
          },
          {
            ...childOpts,
            dependsOn: httpRouteDeps,
          }
        );

        httpRouteDeps.push(this.forwardAuthMiddleware);
      }

      // Determine TLS configuration
      const tlsIssuerName = args.tls?.clusterIssuerName || "letsencrypt-prod";
      const hasTLS = args.tls?.clusterIssuer || args.tls?.clusterIssuerName;

      // Build HTTPRoute spec
      const httpRouteSpec: any = {
        parentRefs: [
          {
            name: gatewayName,
            namespace: gatewayNamespace,
          },
        ],
        hostnames: [args.domain],
        rules: [
          // Extra path prefixes first. Gateway API gives precedence to the longest PathPrefix
          // across rules anyway; list order only breaks ties.
          ...extraRoutes.map((r) => ({
            matches: [{ path: { type: "PathPrefix", value: r.pathPrefix } }],
            backendRefs: [{ name: r.serviceName, port: r.servicePort }],
          })),
          {
            matches: [
              {
                path: {
                  type: "PathPrefix",
                  value: "/",
                },
              },
            ],
            backendRefs: [
              {
                name: this.service.metadata.name,
                port: 80,
              },
            ],
          },
        ],
      };

      // Add ForwardAuth middleware for Authelia authentication
      if (args.auth === AuthType.FORWARD && this.forwardAuthMiddleware) {
        // Every rule, extra paths included: they are on the same protected host.
        const filters = [
          {
            type: "RequestHeaderModifier",
            requestHeaderModifier: {
              set: [
                {
                  name: "X-Original-URL",
                  value: `https://${args.domain}`,
                },
                {
                  name: "X-Original-Method",
                  value: "GET",
                },
              ],
            },
          },
          {
            type: "ExtensionRef",
            extensionRef: {
              group: "traefik.io",
              kind: "Middleware",
              name: this.forwardAuthMiddleware.metadata.name,
            },
          },
        ];
        for (const rule of httpRouteSpec.rules) {
          rule.filters = filters;
        }
      }

      // Create Gateway API HTTPRoute
      this.route = new k8s.apiextensions.CustomResource(
        `${name}-httproute`,
        {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "HTTPRoute",
          metadata: {
            name: name,
            namespace: namespace.metadata.name,
            annotations: hasTLS
              ? {
                  "cert-manager.io/cluster-issuer": tlsIssuerName,
                }
              : {},
          },
          spec: httpRouteSpec,
        },
        {
          ...childOpts,
          dependsOn: httpRouteDeps,
        }
      );
    }

    // Optional: Create Cloudflare DNS record
    if (args.cloudflare) {
      this.dnsRecord = new cloudflare.Record(
        `${name}-dns`,
        {
          zoneId: args.cloudflare.zoneId,
          name: args.domain,
          type: "CNAME",
          content: args.cloudflare.tunnelCname,
          // Proxy through Cloudflare to enable both IPv4 and IPv6
          proxied: true,
          comment: `Managed by Pulumi - ${name}`,
          // Allow Pulumi to take ownership of a pre-existing record with the
          // same name/type (e.g. when migrating from manually-created records
          // or when the Pulumi URN changes due to refactoring).
          allowOverwrite: true,
        },
        childOpts
      );
    }

    this.registerOutputs({
      namespaceName: this.namespace.metadata.name,
      deploymentName: this.deployment.metadata.name,
      serviceName: this.service.metadata.name,
      routeName: Array.isArray(this.route)
        ? this.route.map((r) => r.metadata.name)
        : this.route.metadata.name,
      forwardAuthMiddlewareName: this.forwardAuthMiddleware?.metadata.name,
      domain: args.domain,
      dnsRecordId: this.dnsRecord?.id,
    });
  }
}
