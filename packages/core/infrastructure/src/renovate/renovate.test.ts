import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

type Created = { type: string; name: string; inputs: Record<string, unknown> };
const created: Created[] = [];

type EnvVar = { name: string; value?: string; valueFrom?: { secretKeyRef?: { key: string } } };
type Mount = { name: string; mountPath: string; readOnly?: boolean };
type Container = {
  name: string;
  image: string;
  command?: string[];
  env?: EnvVar[];
  volumeMounts?: Mount[];
  securityContext?: Record<string, unknown>;
};
type Volume = {
  name: string;
  emptyDir?: { medium?: string; sizeLimit?: string };
  configMap?: { name: string; defaultMode?: number };
};
type PodSpec = {
  securityContext?: Record<string, unknown>;
  initContainers?: Container[];
  containers: Container[];
  volumes?: Volume[];
};

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
    "test",
    false
  );
  const { createRenovate } = await import("./index");
  const eso = new pulumi.CustomResource("test:index:Operator", "eso", {});
  createRenovate({ externalSecretsOperator: eso });
  await new Promise((r) => setTimeout(r, 50));
});

const byType = (type: string) => created.find((c) => c.type === type);
const podSpec = () => {
  const cronJob = byType("kubernetes:batch/v1:CronJob");
  const spec = cronJob?.inputs.spec as {
    jobTemplate: { spec: { template: { spec: PodSpec } } };
  };
  return spec.jobTemplate.spec.template.spec;
};
const initContainer = () => podSpec().initContainers?.find((c) => c.name === "mint-token");
const renovate = () => podSpec().containers.find((c) => c.name === "renovate");
const env = (c: Container | undefined, name: string) => c?.env?.find((e) => e.name === name);
const configMap = () => byType("kubernetes:core/v1:ConfigMap");

describe("renovate CronJob: GitHub App token", () => {
  it("mints the installation token in an init container from the App secret", () => {
    const init = initContainer();
    expect(init).toBeDefined();
    expect(init?.command).toEqual(["node", "/opt/renovate-token/mint-token.mjs"]);
    expect(env(init, "GITHUB_APP_ID")?.valueFrom?.secretKeyRef?.key).toBe("app_id");
    expect(env(init, "GITHUB_APP_INSTALLATION_ID")?.valueFrom?.secretKeyRef?.key).toBe(
      "installation_id"
    );
    expect(env(init, "GITHUB_APP_PRIVATE_KEY")?.valueFrom?.secretKeyRef?.key).toBe("private_key");
    expect(env(init, "TOKEN_FILE")?.value).toBe("/run/renovate-token/token");
  });

  it("limits the token to the repositories Renovate maintains", () => {
    expect(env(initContainer(), "GITHUB_REPOSITORIES")?.value).toBe(
      "homelab,homelab-apps,local-ai,homelab-wiki"
    );
  });

  it("keeps the token in an in-memory volume shared by both containers", () => {
    const volume = podSpec().volumes?.find((v) => v.name === "token");
    expect(volume?.emptyDir?.medium).toBe("Memory");
    expect(volume?.emptyDir?.sizeLimit).toBe("1Mi");
    expect(initContainer()?.volumeMounts).toContainEqual({
      name: "token",
      mountPath: "/run/renovate-token",
    });
    expect(renovate()?.volumeMounts).toContainEqual({
      name: "token",
      mountPath: "/run/renovate-token",
      readOnly: true,
    });
  });

  it("hands the token to Renovate through a config file that reads the token file", () => {
    expect(env(renovate(), "RENOVATE_CONFIG_FILE")?.value).toBe("/etc/renovate/config.js");
    expect(renovate()?.volumeMounts).toContainEqual({
      name: "scripts",
      mountPath: "/etc/renovate",
      readOnly: true,
    });
    const data = configMap()?.inputs.data as Record<string, string>;
    expect(data["config.js"]).toContain("/run/renovate-token/token");
    expect(data["mint-token.mjs"]).toContain("access_tokens");
  });

  it("sets the App's bot username as the GitHub App docs describe", () => {
    expect(env(renovate(), "RENOVATE_USERNAME")?.value).toBe("digitaleraluhut-renovate[bot]");
  });

  it("gives the renovate container no App secret and no non-existent RENOVATE_GITHUB_APP_* options", () => {
    const vars = renovate()?.env ?? [];
    expect(vars.filter((e) => e.valueFrom)).toEqual([]);
    expect(vars.map((e) => e.name).filter((n) => n.startsWith("RENOVATE_GITHUB_APP"))).toEqual([]);
  });

  it("pins one Renovate image by digest for both containers", () => {
    const image = renovate()?.image;
    expect(image).toMatch(/^renovate\/renovate:41\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(initContainer()?.image).toBe(image);
  });
});

describe("renovate CronJob: pod security restricted", () => {
  it("runs the pod as the image's non-root user with the runtime's seccomp profile", () => {
    expect(podSpec().securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 12021,
      seccompProfile: { type: "RuntimeDefault" },
    });
  });

  it("drops all capabilities and privilege escalation in both containers", () => {
    for (const c of [initContainer(), renovate()]) {
      expect(c?.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        privileged: false,
        capabilities: { drop: ["ALL"] },
      });
    }
    expect(initContainer()?.securityContext?.readOnlyRootFilesystem).toBe(true);
  });

  it("enforces the restricted profile on the namespace", () => {
    const ns = byType("kubernetes:core/v1:Namespace");
    const labels = (ns?.inputs.metadata as { labels: Record<string, string> }).labels;
    expect(labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });
});
