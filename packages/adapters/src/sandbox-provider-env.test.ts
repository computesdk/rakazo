import { describe, expect, it } from "vitest";
import { resolveSandboxProvider, sandboxProviderOptionsFromEnv } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("keeps explicit none", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toBe("none");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "daytona" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "createos" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "box" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "computesdk" })).toBe("none");
    expect(
      resolveSandboxProvider({ SANDBOX_PROVIDER: "computesdk", COMPUTESDK_PROVIDER: "e2b" }),
    ).toBe("none");
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "computesdk",
        COMPUTESDK_PROVIDER: "flyio",
        FLY_API_TOKEN: "test-token",
      }),
    ).toBe("none");
  });

  it("keeps computesdk when its backend credential is set", () => {
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "computesdk",
        COMPUTESDK_PROVIDER: "e2b",
        E2B_API_KEY: "test-e2b-key",
      }),
    ).toBe("computesdk");
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "computesdk",
        COMPUTESDK_PROVIDER: "namespace",
        NSC_TOKEN_FILE: "/run/secrets/nsc",
      }),
    ).toBe("computesdk");
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "computesdk",
        COMPUTESDK_PROVIDER: "modal",
        MODAL_TOKEN_ID: "tok-id",
        MODAL_TOKEN_SECRET: "tok-secret",
      }),
    ).toBe("computesdk");
  });

  it("keeps CreateOS when its API key is set", () => {
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "createos",
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
      }),
    ).toBe("createos");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toBe("none");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});

describe("sandboxProviderOptionsFromEnv", () => {
  it("loads CreateOS settings from the shared env contract", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
        CREATEOS_SANDBOX_BASE_URL: "https://api.example.test",
        CREATEOS_SANDBOX_SHAPE: "s-4vcpu-8gb",
        CREATEOS_SANDBOX_ROOTFS: "desktop:2",
      }),
    ).toMatchObject({
      createosApiKey: "test-createos-key",
      createosBaseUrl: "https://api.example.test",
      createosShape: "s-4vcpu-8gb",
      createosRootfs: "desktop:2",
    });
  });
});
