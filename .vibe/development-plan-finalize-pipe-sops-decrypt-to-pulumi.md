# Development Plan: homelab (finalize/pipe-sops-decrypt-to-pulumi branch)

*Generated on 2026-05-28 by Vibe Feature MCP*
*Workflow: [minor](https://mrsimpson.github.io/responsible-vibe-mcp/workflows/minor)*

## Goal
Finalize the refactor of `homelab-config/restore-config.sh` that pipes `sops -d` output directly to Python via stdin — avoiding any decrypted secrets touching disk. All code changes are already merged to main (PRs #48, #49). CI run #8 passed. This phase confirms the work is complete and cleans up.

## Explore
<!-- beads-phase-id: homelab-11.1 -->

### Phase Entrance Criteria
*(initial phase — no prior criteria)*

### Tasks

*Tasks managed via `bd` CLI*

## Implement
<!-- beads-phase-id: homelab-11.2 -->

### Phase Entrance Criteria
- [ ] Scope of remaining work is clear (none — code already merged)

### Tasks

*Tasks managed via `bd` CLI*

## Finalize
<!-- beads-phase-id: homelab-11.3 -->

### Phase Entrance Criteria
- [x] `restore-config.sh` no longer writes decrypted YAML to disk (merged in #48, #49)
- [x] CI run #8 succeeded with the new piping approach
- [ ] Stale local branches cleaned up
- [ ] Plan file updated to reflect completion

### Tasks

*Tasks managed via `bd` CLI*

## Key Decisions
1. Pipe `sops -d` stdout to `python3 -c "$(cat << 'PYTHON' ... PYTHON)"` — heredoc embeds the script as a `-c` arg, leaving stdin free for the pipe.
2. Use `export VAR` before the pipe so both sides of the subshell inherit the environment variables.
3. The AGE private key still uses a `mktemp` file (acceptable — it's the private key, not config secrets, and is `chmod 600`).

## Notes
- PRs merged: #48 (refactor), #49 (fix env var export)
- CI run #8: ✅ success
- All previous plan context: `.vibe/development-plan-refactor-pipe-sops-decrypt-to-pulumi.md`

---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
