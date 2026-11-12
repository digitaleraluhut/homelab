import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

// The resources move from stack mrsimpson/aftertouch/dev with `pulumi state move`. That only
// keeps them (and the data volume) if type, name and parent stay exactly as they were.
const created: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "homelab",
    "dev",
    false
  );
  pulumi.runtime.setAllConfig({
    "aftertouch:image": "ghcr.io/gesellix/bose-soundtouch:0.86",
    "aftertouch:nodeIp": "192.0.2.5",
    "aftertouch:nodeName": "flinker",
    "aftertouch:mgmtUsername": "u",
    "aftertouch:mgmtPassword": "p",
    "aftertouch:discoverySubnets": "198.51.100.0/24",
    "aftertouch:preferredDevices": "198.51.100.10,198.51.100.11",
  });
  const { setupAftertouch } = await import("./index");
  setupAftertouch();
  await new Promise((r) => setTimeout(r, 50));
});

describe("setupAftertouch", () => {
  it("declares exactly the resources of the former aftertouch stack, same types and names", () => {
    expect(created.map((c) => `${c.type}::${c.name}`).sort()).toEqual(
      [
        "kubernetes:core/v1:Namespace::aftertouch-ns",
        "kubernetes:core/v1:Secret::aftertouch-mgmt",
        "kubernetes:core/v1:PersistentVolumeClaim::aftertouch-pvc",
        "kubernetes:apps/v1:Deployment::aftertouch-deployment",
        "kubernetes:core/v1:Service::aftertouch-svc",
        "kubernetes:core/v1:Service::aftertouch-http",
        "kubernetes:core/v1:Service::aftertouch-https",
        "kubernetes:core/v1:Service::aftertouch-web",
      ].sort()
    );
  });

  it("runs the pinned upstream releases, whatever the stack config says", () => {
    const deployment = created.find((c) => c.name === "aftertouch-deployment");
    const containers = (
      deployment?.inputs.spec as {
        template: { spec: { containers: Array<{ name: string; image: string }> } };
      }
    ).template.spec.containers;
    expect(Object.fromEntries(containers.map((c) => [c.name, c.image]))).toEqual({
      app: "ghcr.io/gesellix/bose-soundtouch:0.139.0",
      web: "ghcr.io/gesellix/bose-soundtouch-web:0.114.0",
    });
  });

  describe("on the pod network instead of the host network", () => {
    type Container = {
      name: string;
      ports: Array<{ containerPort: number; hostPort?: number }>;
      env?: Array<{ name: string; value: string }>;
      securityContext?: Record<string, unknown>;
    };
    const podSpec = () =>
      (
        created.find((c) => c.name === "aftertouch-deployment")?.inputs.spec as {
          template: { spec: Record<string, unknown> & { containers: Container[] } };
        }
      ).template.spec;
    const container = (name: string) => podSpec().containers.find((c) => c.name === name);

    it("does not share the node's network namespace", () => {
      expect(podSpec().hostNetwork).toBeFalsy();
    });

    // With hostNetwork the server saw the node's hostname and put it into its TLS certificate
    // and its expected hosts. A pod name would change with every pod and regenerate the cert.
    it("keeps the node's hostname inside the pod", () => {
      expect(podSpec().hostname).toBe("flinker");
    });

    // The speakers were migrated to <node>:8000 and :8443; another port means re-migrating each
    // speaker. hostPort keeps the addresses and, unlike a NodePort, the speaker's source IP,
    // which the server uses to push credentials back to the speaker.
    it("keeps the speakers' host ports 8000 and 8443 and the web UI on 9090", () => {
      const hostPorts = podSpec().containers.flatMap((c) => c.ports.map((p) => p.hostPort));
      expect(hostPorts.sort()).toEqual([8000, 8443, 9090]);
      for (const c of podSpec().containers) {
        for (const p of c.ports) expect(p.hostPort).toBe(p.containerPort);
      }
    });

    it("runs as the image's unprivileged user with no capabilities but binding ports", () => {
      expect(podSpec().securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        fsGroup: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      });
      // The server binary carries the file capability cap_net_bind_service=+ep; without it in
      // the bounding set exec fails with EPERM. pod-security "restricted" allows exactly this one.
      expect(container("app")?.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
      });
      expect(container("web")?.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      });
    });

    // Multicast (SSDP/mDNS) does not reach the LAN from the pod network; the server then finds
    // speakers by a unicast scan of these subnets. PREFERRED_DEVICES is not read by the server.
    it("scans the configured LAN subnets and sets nothing the server ignores", () => {
      expect(container("app")?.env).toEqual([
        { name: "BASE_URL", value: "http://aftertouch.flinker.fritz.box" },
        { name: "DISCOVERY_SUBNETS", value: "198.51.100.0/24" },
        { name: "DISCOVERY_SCAN_INTERVAL", value: "1h" },
      ]);
    });

    // hostPort is not allowed by pod-security "baseline", so the namespace stays privileged.
    it("enforces privileged pod security and reports what a baseline namespace would refuse", () => {
      const ns = created.find((c) => c.name === "aftertouch-ns");
      expect((ns?.inputs.metadata as { labels: Record<string, string> }).labels).toEqual({
        app: "aftertouch",
        "pod-security.kubernetes.io/enforce": "privileged",
        "pod-security.kubernetes.io/warn": "baseline",
        "pod-security.kubernetes.io/audit": "baseline",
      });
    });
  });

  it("keeps the data volume claim name", () => {
    const pvc = created.find((c) => c.name === "aftertouch-pvc");
    expect((pvc?.inputs.metadata as { name: string }).name).toBe("aftertouch-data");
  });
});
