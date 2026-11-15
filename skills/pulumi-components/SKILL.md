---
name: pulumi-components
description: "When changing homelab-core-components (packages/core/components): test deploy and preview with Pulumi mocks before publishing."
---
# Changing homelab-core-components

Apps depend on the published package; a fault reaches every app on its next deploy.

- **Test both paths with Pulumi mocks.** In a preview, resources that do not exist yet have no ID
  (`pulumi.runtime.unknownValue`); a component that reads a resource by a known ID fails the whole
  preview. CI deploys run `pulumi up` without a separate preview, so a preview-only fault shows up
  only in someone's local preview. Example: `src/app-namespace.preview.test.ts`.
- **New options default to today's behaviour**, with a test that the output is unchanged when the
  option is not set (e.g. `strategy`, `backendProtocol` in ExposedWebApp).
- **After publishing**, diff the published package against the previous version (`npm pack` both,
  `diff -r package/dist`) before raising it in homelab-apps; say in the PR which apps it affects.
