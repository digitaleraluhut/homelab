# ADR 019: Isolated CI runners (microVM per job) for GitHub

## Status

Proposed

## Context

Issue #83 asks for fast self-hosted GitHub Actions runners on flinker, each job in a throwaway microVM. Gitea is a separate topic and not covered here.

Facts (observed 2026-11-08/10): `/dev/kvm` is present (`root:kvm`, mode 0660); 32 vCPUs; 109 GiB RAM, of which about 54 GiB were available on 2026-11-10 after the owner freed memory; single-node k3s v1.34.3 with containerd 2.1.5-k3s1. The repositories are public, so fork PRs are the main threat. The earlier attempt (Kata `kata-deploy:latest` with `hostPID` and a mount of the host's `/etc/containerd`, devmapper snapshotter, a separate Pulumi stack) was deleted unmerged.

## Decision (proposed)

1. **Trust model.** An org runner group restricted to selected repositories. Only `push` to `main` and `workflow_dispatch` by maintainers use it. Never `pull_request` from forks. Deploys and anything with production secrets stay on GitHub-hosted runners.
2. **One job, one VM.** Runners are ephemeral and just-in-time (JIT) registered: actions-runner-controller (runner scale set mode) in its own namespace, with a runtime class that starts each runner pod in a microVM (Kata Containers). The microVM has no host mounts, no service-account token, no cluster API access.
3. **Network.** Default-deny egress for the runner namespace. Allowed: GitHub, container registries, package mirrors, DNS. Denied: LAN, tailnet, the node itself, the cluster API.
4. **Budget (proposal, not measured).** Max 1 concurrent VM at 4 vCPU / 8 GiB, hard limits on the pod. Raise to 2 only after a trial shows the LLM side copes.
5. **Hypervisor.** Prefer the Kata hypervisor that needs no new storage setup on k3s (Cloud Hypervisor or QEMU). Firecracker needs the devmapper snapshotter, which k3s does not configure; choose it only if the trial shows a clear gain. To be decided in the trial.
6. **Installation.** Node-level parts (kvm group, Kata payload, containerd runtime class for k3s) are installed from `host/` by Ansible with pinned versions and owner review, not by a privileged in-cluster installer. ARC, the namespace and the network policies are cluster resources in the Pulumi project.

## Consequences

- A container escape inside a job lands in the guest kernel, not on the host. A hypervisor escape remains possible and needs patching discipline (pinned versions, Renovate).
- Jobs can still exfiltrate what they hold over the allowed egress. Mitigation: minimal `permissions:` and no production secrets.
- Memory is shared with the LLMs; the budget caps the runners, it does not reserve memory. A runaway LLM load can starve the VM and the reverse.
- Changing the containerd config of k3s means a k3s restart (allowed to the operator via sudo whitelist, but it interrupts all workloads briefly); schedule it.
- The runner group and the workflow `runs-on` labels are changed by the owner (`.github/workflows/` is outside the operator's rights).

## Open points for the owner

- Budget (point 4) and which repositories join the group (point 1).
- Whether a first trial on one test repository is acceptable.

## Verification plan (not yet done)

Trial on flinker: start a throwaway pod with the runtime class, check `uname -r` differs from the host, no token mounted, egress to LAN/tailnet blocked, memory limit enforced, VM gone after the job.
