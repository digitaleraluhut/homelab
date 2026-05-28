# Development Plan: homelab (refactor/clear-smoke-testing-apps-relationship branch)

*Generated on 2026-05-28 by Vibe Feature MCP*
*Workflow: [epcc](https://mrsimpson.github.io/responsible-vibe-mcp/workflows/epcc)*

## Goal
*Define what you're building or fixing - this will be updated as requirements are gathered*

## Explore
<!-- beads-phase-id: homelab-10.1 -->
### Tasks
<!-- beads-synced: 2026-05-28 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-10.1.1` Identify current apps in homelab repo and their purpose
- [x] `homelab-10.1.2` Analyze relationship between homelab and homelab-apps repos
- [x] `homelab-10.1.3` Determine how to denote apps as demo/smoke-testing

## Plan
<!-- beads-phase-id: homelab-10.2 -->

### Phase Entrance Criteria
- [ ] The relationship between homelab and homelab-apps repos is understood and documented.
- [ ] The current apps in this repo have been identified and their purpose clarified.
- [ ] Alternatives for making the repo connection transparent have been evaluated.

### Tasks
<!-- beads-synced: 2026-05-28 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-10.2.1` Rename packages/apps/ to packages/demo-apps/ and update workspace paths
- [x] `homelab-10.2.2` Update README to clearly separate demo apps from homelab-apps
- [x] `homelab-10.2.3` Update demo app package.json files with demo descriptions and new repo URL
- [x] `homelab-10.2.4` Mark inline apps in src/index.ts as demo/smoke-test with comments
- [x] `homelab-10.2.5` Update root package.json repository URL and git remote

## Code
<!-- beads-phase-id: homelab-10.3 -->

### Phase Entrance Criteria
- [ ] The plan for denoting demo/smoke-testing apps is defined.
- [ ] The approach for linking to the homelab-apps repo is decided.
- [ ] All implementation tasks are created and assigned to phases.

### Tasks
<!-- beads-synced: 2026-05-28 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-10.3.1` Rename packages/apps/ to packages/demo-apps/
- [x] `homelab-10.3.2` Update README with demo-apps section and org references
- [x] `homelab-10.3.3` Update demo app package.json descriptions and repo URLs
- [x] `homelab-10.3.4` Add demo/smoke-test comments to inline apps in src/index.ts
- [x] `homelab-10.3.5` Update root package.json repository URL
- [x] `homelab-10.3.6` Update docs/howto/ references to packages/apps/
- [x] `homelab-10.3.7` Update GitHub Actions references from mrsimpson to digitaleraluhut

## Commit
<!-- beads-phase-id: homelab-10.4 -->

### Phase Entrance Criteria
- [ ] All code changes are implemented and tested.
- [ ] Documentation (README, comments) is updated to reflect the new repo relationship.
- [ ] Changes are reviewed and ready for commit.

### Tasks
<!-- beads-synced: 2026-05-28 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Key Decisions
1. **New GitHub org**: `digitaleraluhut`. `homelab-apps` has already been moved there; `homelab` remote still points to `mrsimpson/homelab` and should be updated.
2. **Npm package scope**: `@mrsimpson/*` is used throughout both repos. Renaming all packages is a large breaking change and was not explicitly requested. Out of scope for this task.
3. **Demo apps**: All apps in `packages/apps/` (hello-world, nodejs-demo, secure-demo, storage-validator) and inline apps in `src/index.ts` (auth-demo, oauth2-demo) are lightweight demos/smoke-tests. Real apps live in `homelab-apps`.
4. **Transparency approach**: Update README with clear separation, rename/rebrand `packages/apps/` as `demo-apps` or similar, update repo URLs in package.json and docs, and clearly mark inline apps as demo/smoke-test in code comments.

## Notes
- Current branch: `refactor/clear-smoke-testing-apps-relationship`
- `homelab-apps` remote: `https://github.com/digitaleraluhut/homelab-apps.git`
- `homelab` remote: `https://github.com/mrsimpson/homelab.git` (needs update)
- In `homelab-apps`, Pulumi configs and workflow calls still reference `mrsimpson/homelab` — those should be updated in a follow-up or as part of this work if in scope.

---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
