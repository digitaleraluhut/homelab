# Development Plan: homelab (refactor/pipe-sops-decrypt-to-pulumi branch)

*Generated on 2026-05-28 by Vibe Feature MCP*
*Workflow: [minor](https://mrsimpson.github.io/responsible-vibe-mcp/workflows/minor)*

## Goal
Refactor `homelab-config/restore-config.sh` to never write decrypted secrets to disk. Instead, pipe the `sops -d` output directly into the Python parsing/restore logic via stdin, so plaintext config values exist only in memory during the CI run.

## Explore
<!-- beads-phase-id: homelab-10.1 -->

### Phase Entrance Criteria
*(initial phase — no prior criteria)*

### Tasks

*Tasks managed via `bd` CLI*

## Implement
<!-- beads-phase-id: homelab-10.2 -->

### Phase Entrance Criteria
- [ ] The current flow (decrypt → tempfile → Python reads file) is fully understood
- [ ] The target approach (sops -d piped to Python stdin) is confirmed feasible
- [ ] Edge cases (multi-line values, temp key file for AGE key) are considered

### Tasks

*Tasks managed via `bd` CLI*

## Finalize
<!-- beads-phase-id: homelab-10.3 -->

### Phase Entrance Criteria
- [ ] `restore-config.sh` no longer writes decrypted YAML to disk
- [ ] Script is tested locally and in CI
- [ ] PR is created and merged

## Key Decisions
1. **Pipe sops stdout to Python stdin**: Replace `sops -d … > $TEMP_CONFIG` + `open(temp_config)` with `sops -d … | python3 -c '…'` so decrypted YAML is never written to disk.
2. **Pass content via stdin, not env var**: Env vars are also visible in `/proc/<pid>/environ` on Linux; stdin is safer.
3. **Keep temp key file for the AGE key**: `sops` requires a key file (not stdin) for the private key. This is acceptable — the private key is already handled with `chmod 600` and is not a config secret.
4. **Remove `TEMP_CONFIG` mktemp entirely**: Once piping, the temp config file variable and its trap can be removed.

## Notes
- The AGE private key itself still needs a temp file (sops requires `SOPS_AGE_KEY_FILE`), but that is the private key, not the secrets — and it's already done with `chmod 600`. The user's concern is specifically about the *decrypted config values* landing on disk.
- `sops -d` can output to stdout (no `> file` needed); Python can read from stdin.
- `python3 << 'HEREDOC'` and a pipe both compete for stdin — this can't work. Use `python3 -c "$(cat << 'HEREDOC' ... HEREDOC)"` to embed the script as a `-c` argument, leaving stdin for the pipe.
- In `cmd | python3`, inline env var assignments (`VAR=val cmd`) only apply to the left side of the pipe. Must use `export VAR` before the pipe so both subshells inherit the variables.
- CI run #8 confirmed successful after all fixes merged (PRs #48 and #49).

---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
