import { describe, expect, it, vi } from "vitest";
import {
  type ComputeSdkProvider,
  type ComputeSdkSandbox,
  ComputeSdkSandboxProvider,
} from "./computesdk-sandbox.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

function fakeSandbox(overrides: Partial<ComputeSdkSandbox> = {}): ComputeSdkSandbox {
  return {
    sandboxId: "sbx-1",
    runCommand: vi.fn(async () => ({ stdout: "/home/dev\n", stderr: "", exitCode: 0 })),
    getUrl: vi.fn(async ({ port }: { port: number }) => `https://sbx-1-${port}.example.test`),
    destroy: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fixture(sandbox?: ComputeSdkSandbox) {
  const created = sandbox ?? fakeSandbox();
  const provider: ComputeSdkProvider = {
    name: "test-backend",
    sandbox: {
      create: vi.fn(async () => created),
      getById: vi.fn(async () => null),
      destroy: vi.fn(async () => undefined),
    },
  };
  return { provider, created };
}

describe("ComputeSdkSandboxProvider", () => {
  it("describes the computesdk provider with full desktop capabilities", () => {
    const { provider } = fixture();
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    expect(adapter.describe()).toMatchObject({
      id: "computesdk",
      capabilities: { graphical: true, persistentHome: true, multiScreen: true },
    });
  });

  it("provisions a fresh sandbox with idle timeout and bot metadata", async () => {
    const { provider, created } = fixture();
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(provider.sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: expect.any(Number),
        metadata: { botId: "bot-a", rakazo: "computer" },
      }),
    );
    expect(ref).toMatchObject({
      id: created.sandboxId,
      botId: "bot-a",
      kind: "computesdk",
      providerRef: created.sandboxId,
      fresh: true,
    });
  });

  it("forwards image, template, and snapshot options to create()", async () => {
    const { provider } = fixture();
    const adapter = new ComputeSdkSandboxProvider({
      provider,
      backend: "daytona",
      image: "rakazo/computer:1",
      snapshotId: "snap-9",
    });
    await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(provider.sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: "rakazo/computer:1", snapshotId: "snap-9" }),
    );
  });

  it("reconnects to a stored providerRef instead of creating", async () => {
    const existing = fakeSandbox({ sandboxId: "sbx-live" });
    const { provider } = fixture();
    provider.sandbox.getById = vi.fn(async () => existing);
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-live", providerKind: "computesdk" },
      context,
    );
    expect(provider.sandbox.create).not.toHaveBeenCalled();
    expect(ref).toMatchObject({ id: "sbx-live", providerRef: "sbx-live", fresh: false });
  });

  it("creates a replacement when the stored providerRef is gone", async () => {
    const { provider, created } = fixture();
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-dead", providerKind: "computesdk" },
      context,
    );
    expect(provider.sandbox.getById).toHaveBeenCalledWith("sbx-dead");
    expect(provider.sandbox.create).toHaveBeenCalled();
    expect(ref.providerRef).toBe(created.sandboxId);
  });

  it("translates a dead sandbox into SandboxNotFoundError for the lifecycle", async () => {
    const dead = fakeSandbox({
      runCommand: vi.fn(async () => {
        throw new Error("connection lost");
      }),
    });
    const { provider } = fixture(dead);
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const iterator = adapter
      .execute(ref, { argv: ["echo", "hi"] }, context)
      [Symbol.asyncIterator]();
    const caught = await iterator
      .next()
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(isSandboxGoneError(caught)).toBe(true);
  });

  it("pauses via the raw vendor sandbox on stop when supported", async () => {
    const pause = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({ getInstance: () => ({ pause }) });
    const { provider } = fixture(sandbox);
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await adapter.stop(ref, context);
    expect(pause).toHaveBeenCalled();
    expect(provider.sandbox.destroy).not.toHaveBeenCalled();
  });

  it("destroys on stop when the backend cannot pause", async () => {
    const { provider } = fixture();
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "modal" });
    const ref = await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await adapter.stop(ref, context);
    expect(provider.sandbox.destroy).toHaveBeenCalledWith(ref.providerRef);
  });

  it("extends the backend timeout on keepAlive when supported", async () => {
    const setTimeout = vi.fn(async () => undefined);
    const sandbox = fakeSandbox({ getInstance: () => ({ setTimeout }) });
    const { provider } = fixture(sandbox);
    const adapter = new ComputeSdkSandboxProvider({ provider, backend: "e2b" });
    const ref = await adapter.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await adapter.keepAlive(ref);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Number));
  });
});
