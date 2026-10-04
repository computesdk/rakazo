import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { sandboxIdleMs } from "./computer-idle.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";

const WORKSPACE_DIRNAME = "rakazo-home";
const BROWSER_PROFILES_DIRNAME = ".browser-profiles";
/** Inline base64 chunks stay well inside provider command-length limits. */
const BASE64_CHUNK_BYTES = 192 * 1024;
const BASE64_CHUNK_CHARS = Math.ceil(BASE64_CHUNK_BYTES / 3) * 4;

/** Minimal ComputeSDK sandbox surface this adapter consumes (see computesdk Sandbox). */
export interface ComputeSdkSandbox {
  sandboxId: string;
  runCommand(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getUrl(options: { port: number; protocol?: string }): Promise<string>;
  destroy(): Promise<void>;
  /** Raw provider sandbox (e2b Sandbox, daytona Sandbox, ...) for pause/keepalive. */
  getInstance?(): unknown;
}

/** Minimal ComputeSDK provider surface (see computesdk DirectProvider). */
export interface ComputeSdkProvider {
  name?: string;
  sandbox: {
    create(options?: Record<string, unknown>): Promise<ComputeSdkSandbox>;
    getById(sandboxId: string): Promise<ComputeSdkSandbox | null>;
    destroy(sandboxId: string): Promise<void>;
  };
}

export interface ComputeSdkSandboxOptions {
  provider: ComputeSdkProvider;
  /** ComputeSDK backend name (e2b, daytona, ...) for logs and env docs. */
  backend: string;
  /** Container/VM image passed to create(); the image must ship a Chrome-family browser. */
  image?: string;
  /** Provider template/image id alternative to image. */
  templateId?: string;
  /** Provider snapshot to restore new computers from. */
  snapshotId?: string;
}

/** Named so the lifecycle's isSandboxGoneError replaces the dead computer row. */
function sandboxGoneError(computer: ComputerRef): Error {
  return Object.assign(new Error(`sandbox ${computer.id} is not running`), {
    name: "SandboxNotFoundError",
  });
}

interface SandboxEnvironment {
  homeDir: string;
  workspaceDir: string;
  browserProfilesDir: string;
}

export class ComputeSdkSandboxProvider implements SandboxProvider {
  private readonly provider: ComputeSdkProvider;
  private readonly backend: string;
  private readonly image?: string;
  private readonly templateId?: string;
  private readonly snapshotId?: string;
  private readonly boxes = new Map<string, ComputeSdkSandbox>();
  private readonly environments = new Map<string, Promise<SandboxEnvironment>>();
  private readonly desktops = new LinuxDesktop({
    environment: async (computer) => {
      const env = await this.computerEnvironment(computer);
      return { ...env, displayStart: 20, portStart: 6100 };
    },
    run: async (computer, command, context) => {
      const result = await this.runChecked(
        await this.box(computer),
        `bash -c ${shellQuote(command)}`,
        context,
      );
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port) => {
      const base = new URL(await (await this.box(computer)).getUrl({ port }));
      base.pathname = "/vnc.html";
      return base.toString();
    },
  });

  constructor(options: ComputeSdkSandboxOptions) {
    this.provider = options.provider;
    this.backend = options.backend;
    this.image = options.image;
    this.templateId = options.templateId;
    this.snapshotId = options.snapshotId;
  }

  describe() {
    return {
      id: "computesdk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef): Promise<ComputeSdkSandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) return existing;
    const connected = await this.provider.sandbox.getById(id);
    if (!connected) throw sandboxGoneError(computer);
    this.boxes.set(id, connected);
    return connected;
  }

  private raw(sandbox: ComputeSdkSandbox): unknown {
    try {
      return sandbox.getInstance?.() ?? sandbox;
    } catch {
      return sandbox;
    }
  }

  private computerEnvironment(computer: ComputerRef): Promise<SandboxEnvironment> {
    const id = computer.providerRef || computer.id;
    const cached = this.environments.get(id);
    if (cached) return cached;
    const pending = (async (): Promise<SandboxEnvironment> => {
      const sandbox = await this.box(computer);
      const result = await this.runChecked(sandbox, 'printf %s "$HOME"');
      const homeDir = result.stdout.trim() || "/root";
      const workspaceDir = `${homeDir}/${WORKSPACE_DIRNAME}`;
      return {
        homeDir,
        workspaceDir,
        browserProfilesDir: `${workspaceDir}/${BROWSER_PROFILES_DIRNAME}`,
      };
    })();
    this.environments.set(id, pending);
    pending.catch(() => {
      if (this.environments.get(id) === pending) this.environments.delete(id);
    });
    return pending;
  }

  /** Run a shell command, translating a dead sandbox into the lifecycle's gone signal. */
  private async runChecked(
    sandbox: ComputeSdkSandbox,
    command: string,
    context?: AdapterContext,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) {
    try {
      return await sandbox.runCommand(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeout ?? boundedSandboxCommandTimeoutMs(undefined),
      });
    } catch (error) {
      if (context?.signal.aborted) throw error;
      const alive = await this.provider.sandbox
        .getById(sandbox.sandboxId)
        .then((current) => current !== null)
        .catch(() => true);
      if (!alive) {
        this.boxes.delete(sandbox.sandboxId);
        throw sandboxGoneError({
          id: sandbox.sandboxId,
          botId: "",
          kind: "computesdk",
          providerRef: sandbox.sandboxId,
        });
      }
      throw error;
    }
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef && request.providerKind === "computesdk") {
      const existing = await this.provider.sandbox.getById(request.providerRef);
      if (existing) {
        this.boxes.set(existing.sandboxId, existing);
        return {
          id: existing.sandboxId,
          botId: request.botId,
          kind: "computesdk",
          providerRef: existing.sandboxId,
          fresh: false,
        };
      }
      // A null lookup is the provider-neutral "gone": fall through to a replacement,
      // which restores the workspace through importWorkspace.
    }
    const created = await this.provider.sandbox.create({
      timeout: sandboxIdleMs(),
      metadata: { botId: request.botId, rakazo: "computer" },
      signal: context.signal,
      ...(this.image ? { image: this.image } : {}),
      ...(this.templateId ? { templateId: this.templateId } : {}),
      ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
    });
    this.boxes.set(created.sandboxId, created);
    return {
      id: created.sandboxId,
      botId: request.botId,
      kind: "computesdk",
      providerRef: created.sandboxId,
      fresh: true,
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    if (computer.fresh) {
      const made = await this.runChecked(
        sandbox,
        `mkdir -p ${shellQuote(env.workspaceDir)}`,
        context,
      );
      if (made.exitCode !== 0) {
        throw new Error(made.stderr || "could not create computer workspace");
      }
    }
    const result = await this.runChecked(sandbox, PREPARE_LINUX_DESKTOP, context);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "could not prepare computer desktop tools");
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const result = await this.runChecked(sandbox, request.argv.map(shellQuote).join(" "), context, {
      cwd: computeSdkCwd(env.workspaceDir, request.cwd),
      env: request.env,
      timeout: timeoutMs,
    });
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.exitCode ?? 0 };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    const target = workspacePath(env.workspaceDir, normalizeWorkspacePath(directory));
    const result = await this.runChecked(
      sandbox,
      `find ${shellQuote(target)} -mindepth 1 -maxdepth 1 -printf '%y|%s|%m|%f\\n'`,
      context,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "computer file listing failed");
    }
    return result.stdout
      .split("\n")
      .filter((line) => line.includes("|"))
      .flatMap((line): ComputerFileEntry[] => {
        const [type, size, mode, name] = line.split("|");
        const relative = normalizeWorkspacePath(
          directory ? `${normalizeWorkspacePath(directory)}/${name}` : (name ?? ""),
        );
        if (type === "d") return [{ path: relative, kind: "dir" as const, size: 0 }];
        if (type !== "f" || !name) return [];
        return [
          {
            path: relative,
            kind: "file" as const,
            size: Number(size) || 0,
            ...(mode && Number(`0o${mode}`) & 0o100 ? { executable: true } : {}),
          },
        ];
      });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    const target = workspacePath(env.workspaceDir, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await this.runChecked(sandbox, `stat -Lc %s -- ${shellQuote(target)}`, context);
      const size = Number(info.stdout.trim());
      if (info.exitCode !== 0) {
        throw new Error(info.stderr || "computer file read failed");
      }
      if (Number.isFinite(size) && size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    const result = await this.runChecked(sandbox, `base64 -- ${shellQuote(target)}`, context);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "computer file read failed");
    }
    return Uint8Array.from(Buffer.from(result.stdout.replace(/\s+/g, ""), "base64"));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    const target = workspacePath(env.workspaceDir, file.path);
    const encoded = Buffer.from(file.content).toString("base64");
    const mkdir = `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf("/")) || env.workspaceDir)}`;
    if (!encoded) {
      const result = await this.runChecked(
        sandbox,
        `${mkdir} && : > ${shellQuote(target)}`,
        context,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || "computer file write failed");
    } else {
      const first = `${mkdir} && printf %s ${shellQuote(encoded.slice(0, BASE64_CHUNK_CHARS))} | base64 -d > ${shellQuote(target)}`;
      const firstResult = await this.runChecked(sandbox, first, context);
      if (firstResult.exitCode !== 0) {
        throw new Error(firstResult.stderr || "computer file write failed");
      }
      for (let offset = BASE64_CHUNK_CHARS; offset < encoded.length; offset += BASE64_CHUNK_CHARS) {
        const chunk = encoded.slice(offset, offset + BASE64_CHUNK_CHARS);
        const result = await this.runChecked(
          sandbox,
          `printf %s ${shellQuote(chunk)} | base64 -d >> ${shellQuote(target)}`,
          context,
        );
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || "computer file write failed");
        }
      }
    }
    if (file.executable) {
      const chmod = await this.runChecked(sandbox, `chmod 700 -- ${shellQuote(target)}`, context);
      if (chmod.exitCode !== 0) throw new Error(chmod.stderr || "computer file chmod failed");
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const sandbox = await this.box(computer);
    const env = await this.computerEnvironment(computer);
    await this.desktops.stopBrowsers(computer, context);
    const listing = await this.runChecked(
      sandbox,
      `cd ${shellQuote(env.workspaceDir)} && find . -mindepth 1 -printf '%y|%m|%P\\n'`,
      context,
    );
    if (listing.exitCode !== 0) {
      throw new Error(listing.stderr || "computer workspace export failed");
    }
    const files = listing.stdout
      .split("\n")
      .filter((line) => line.startsWith("f|"))
      .map((line) => {
        const [, mode, relative] = line.split("|");
        return { relative: normalizeWorkspacePath(relative ?? ""), mode: mode ?? "" };
      })
      .filter(({ relative }) => relative && !shouldSkipPortableWorkspaceFile(relative));
    for (let index = 0; index < files.length; index += 8) {
      const batch = await Promise.all(
        files.slice(index, index + 8).map(async ({ relative, mode }) => {
          const result = await this.runChecked(
            sandbox,
            `base64 -- ${shellQuote(workspacePath(env.workspaceDir, relative))}`,
            context,
          );
          if (result.exitCode !== 0) {
            if (relative.startsWith(`${BROWSER_PROFILES_DIRNAME}/`)) return undefined;
            throw new Error(result.stderr || `computer workspace export failed at ${relative}`);
          }
          return {
            path: relative,
            content: Uint8Array.from(Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")),
            executable: Boolean(Number(`0o${mode}`) & 0o100),
          };
        }),
      );
      for (const file of batch) {
        if (file) yield file;
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    for await (const file of files) {
      context.signal.throwIfAborted();
      await this.writeFile(computer, file, context);
    }
    // Imported browser profiles remain dormant until their owning bot needs a desktop.
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const sandbox = await this.box(computer);
    const raw = this.raw(sandbox) as { setTimeout?: (ms: number) => Promise<unknown> };
    if (typeof raw.setTimeout === "function") {
      await raw.setTimeout(sandboxIdleMs()).catch(() => undefined);
    }
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = this.boxes.get(id) ?? (await this.provider.sandbox.getById(id));
    this.forget(id);
    if (!sandbox) return;
    const raw = this.raw(sandbox) as {
      pause?: () => Promise<unknown>;
      stop?: () => Promise<unknown>;
    };
    // Providers that pause keep the workspace warm for reconnect; the rest are
    // destroyed and the next provision restores the checkpointed workspace.
    if (typeof raw.pause === "function") {
      await raw.pause().catch(() => undefined);
      return;
    }
    if (typeof raw.stop === "function") {
      await raw.stop().catch(() => undefined);
      return;
    }
    await this.provider.sandbox.destroy(id).catch(() => undefined);
    void context;
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    this.forget(id);
    await this.provider.sandbox.destroy(id).catch(() => undefined);
    void context;
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.environments.delete(id);
  }
}

function computeSdkCwd(workspaceDir: string, cwd: string | undefined): string {
  if (!cwd || cwd === "." || cwd === "/" || cwd === "/home/rakazo" || cwd === workspaceDir) {
    return workspaceDir;
  }
  const relative = cwd.startsWith(`${workspaceDir}/`)
    ? cwd.slice(workspaceDir.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return workspacePath(workspaceDir, relative);
}
