# Development Plan: homelab (refactor/remove-temp-key-file branch)

*Generated on 2026-05-28 by Vibe Feature MCP*
*Workflow: [minor](https://mrsimpson.github.io/responsible-vibe-mcp/workflows/minor)*

## Goal
Remove the `TEMP_KEY` mktemp file from `restore-config.sh`. `sops` supports `SOPS_AGE_KEY` (the private key content) as a native environment variable — no file on disk needed. The script currently converts `SOPS_AGE_KEY` → temp file → `SOPS_AGE_KEY_FILE`, which is unnecessary.

## Explore
<!-- beads-phase-id: homelab-12.1 -->

### Phase Entrance Criteria
*(initial phase — no prior criteria)*

### Tasks
*Tasks managed via `bd` CLI*

## Implement
<!-- beads-phase-id: homelab-12.2 -->

### Phase Entrance Criteria
- [x] `SOPS_AGE_KEY` env var confirmed working natively with sops (user verified)
- [x] Scope is clear: remove `TEMP_KEY` mktemp, `trap`, and all branches that write the key to a file

### Tasks
*Tasks managed via `bd` CLI*

## Finalize
<!-- beads-phase-id: homelab-12.3 -->

### Phase Entrance Criteria
- [ ] `TEMP_KEY` and its `trap` are removed
- [ ] Script tested and CI passes

## Key Decisions
1. `SOPS_AGE_KEY` is natively supported by sops — no need to write it to a temp file.
2. Remove `TEMP_KEY=$(mktemp)`, `trap "rm -f $TEMP_KEY" EXIT`, and all `echo "$SOPS_AGE_KEY" > "$TEMP_KEY"` / `cat > "$TEMP_KEY"` branches.
3. When `SOPS_AGE_KEY` is already set, pass it straight through (it's already exported). When a key file path is given via `SOPS_AGE_KEY_FILE`, keep that branch. Remove the stdin-pipe-key fallback (it competed with the config pipe in the previous refactor anyway).

## Notes
- The stdin fallback (`cat > "$TEMP_KEY"` when `! -t 0`) was already broken after the previous refactor, because stdin is now used for the sops pipe. It can simply be removed.
- CI uses `SOPS_AGE_KEY` secret — that path is the hot path and becomes a no-op (just `export SOPS_AGE_KEY`).

---
*This plan is maintained by the LLM and uses beads CLI for task management.*
