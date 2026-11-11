/**
 * @mrsimpson/homelab-components
 *
 * Reusable Pulumi components for homelab infrastructure
 */

export { ExposedWebApp, AuthType } from "./ExposedWebApp";
export {
  APP_NAMESPACE_LABEL,
  APP_NAMESPACE_OWNER,
  CI_SUBJECT,
  createAppNamespace,
  DEPLOYER_ROLE,
} from "./app-namespace";
export { HomelabContext } from "./homelab-context";
export { createHomelabContextFromStack } from "./createHomelabContextFromStack";
export type { HomelabContextFromStackOptions } from "./createHomelabContextFromStack";
export {
  createGhcrImagePullSecret,
  createDockerHubImagePullSecret,
} from "./registry-secrets";
export type {
  ExposedWebAppArgs,
  StorageConfig,
  CloudflareConfig,
  TLSConfig,
  GatewayApiConfig,
  ExternalSecretsConfig,
} from "./ExposedWebApp";
export type { HomelabContextConfig } from "./homelab-context";
export type { CreateImagePullSecretArgs } from "./registry-secrets";
export { PostgresInstance } from "./postgres/PostgresInstance";
export type { PostgresInstanceArgs } from "./postgres/PostgresInstance";
