import { parse } from "shell-quote";
import type { ComputeSdkProvider, ComputeSdkSandbox } from "./computesdk-sandbox.js";
import { ComputeSdkSandboxProvider } from "./computesdk-sandbox.js";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";

interface EmulatedFile {
  content: Uint8Array;
  executable: boolean;
}

/**
 * In-memory ComputeSDK backend: sandbox lifecycle plus a shell that understands only what the
 * adapter sends — `bash -c` unwrap, env/echo/printenv, mkdir, base64 writes and reads, stat,
 * chmod, find listings, and the desktop slot/release protocol from desktopCommandResponder.
 */
class ComputeSdkEmulatedSandbox implements ComputeSdkSandbox {
  readonly files = new Map<string, EmulatedFile>();
  readonly dirs = new Set(["/root", "/root/rakazo-home"]);
  alive = true;

  constructor(
    public readonly sandboxId: string,
    private readonly respond: ReturnType<typeof desktopCommandResponder>,
  ) {}

  async getUrl({ port }: { port: number }) {
    return `https://${this.sandboxId}-${port}.computesdk.test`;
  }

  async destroy() {
    this.alive = false;
  }

  async runCommand(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) {
    if (!this.alive) throw new Error(`sandbox ${this.sandboxId} is not running`);
    const env = options?.env ?? {};
    const handled = this.respond(command);
    if (handled) return { ...handled, exitCode: handled.exitCode ?? 0 };
    if (command.includes('printf %s "$HOME"')) {
      return { exitCode: 0, stdout: "/root\n", stderr: "" };
    }
    // PREPARE_LINUX_DESKTOP: every tool is already installed.
    if (command.startsWith("set -eu")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.startsWith("export CHROME_USER_DATA_DIR")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const inner = this.unwrap(command);
    return this.shell(inner, env);
  }

  private unwrap(command: string): string {
    const argv = parse(command).filter((part): part is string => typeof part === "string");
    if (argv[0] === "bash" && argv[1] === "-c" && argv[2]) return argv[2];
    return command;
  }

  private write(target: string, bytes: Uint8Array, append: boolean) {
    const existing = append ? (this.files.get(target)?.content ?? new Uint8Array()) : undefined;
    this.files.set(target, {
      content: existing ? concat(existing, bytes) : bytes,
      executable: this.files.get(target)?.executable ?? false,
    });
  }

  private shell(
    command: string,
    env: Record<string, string>,
  ): { exitCode: number; stdout: string; stderr: string } {
    const mkdir = command.match(/^mkdir -p '([^']+)' && (.*)$/s);
    if (mkdir) {
      this.dirs.add(mkdir[1]!);
      command = mkdir[2]!;
    } else {
      const mkdirOnly = command.match(/^mkdir -p '([^']+)'$/);
      if (mkdirOnly) {
        this.dirs.add(mkdirOnly[1]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
    const b64write = command.match(/^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d (>>?) '([^']+)'$/);
    if (b64write) {
      const bytes = Uint8Array.from(Buffer.from(b64write[1]!, "base64"));
      this.parents(b64write[3]!);
      this.write(b64write[3]!, bytes, b64write[2] === ">>");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const truncate = command.match(/^: > '([^']+)'$/);
    if (truncate) {
      this.parents(truncate[1]!);
      this.write(truncate[1]!, new Uint8Array(), false);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const chmod = command.match(/^chmod 700 -- '([^']+)'$/);
    if (chmod) {
      const file = this.files.get(chmod[1]!);
      if (!file) return { exitCode: 1, stdout: "", stderr: "no such file" };
      file.executable = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const stat = command.match(/^stat -Lc %s -- '([^']+)'$/);
    if (stat) {
      const file = this.files.get(stat[1]!);
      if (!file) return { exitCode: 1, stdout: "", stderr: "cannot stat: no such file" };
      return { exitCode: 0, stdout: `${file.content.byteLength}\n`, stderr: "" };
    }
    const cat = command.match(/^base64 -- '([^']+)'$/);
    if (cat) {
      const file = this.files.get(cat[1]!);
      if (!file) return { exitCode: 1, stdout: "", stderr: "no such file" };
      return {
        exitCode: 0,
        stdout: `${Buffer.from(file.content).toString("base64")}\n`,
        stderr: "",
      };
    }
    const findShallow = command.match(
      /^cd '([^']+)' && find \. -mindepth 1 -printf '%y\|%m\|%P\\n'$/,
    );
    if (findShallow) {
      return { exitCode: 0, stdout: this.findRecursive(findShallow[1]!), stderr: "" };
    }
    const findFlat = command.match(/^find '([^']+)' -mindepth 1 -maxdepth 1 -printf /);
    if (findFlat) {
      return { exitCode: 0, stdout: this.findFlat(findFlat[1]!), stderr: "" };
    }
    // env wrappers, echo, printenv and anything else with argv-shaped content.
    const argv = parse(command).filter((part): part is string => typeof part === "string");
    const out = simpleCommand(argv, env);
    return { exitCode: out.exitCode ?? 0, stdout: out.stdout ?? "", stderr: "" };
  }

  private parents(path: string) {
    let dir = path.slice(0, path.lastIndexOf("/"));
    while (dir) {
      this.dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }

  private findFlat(dir: string): string {
    const lines: string[] = [];
    for (const entry of this.dirs) {
      if (entry === dir || this.isDirectParent(dir, entry)) {
        if (entry !== dir) lines.push(`d|0|755|${entry.slice(dir.length + 1)}\n`);
      }
    }
    for (const [path, file] of this.files) {
      if (this.isDirectParent(dir, path)) {
        lines.push(
          `f|${file.content.byteLength}|${file.executable ? "755" : "644"}|${path.slice(dir.length + 1)}\n`,
        );
      }
    }
    return lines.join("");
  }

  private isDirectParent(dir: string, path: string) {
    return path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/");
  }

  private findRecursive(dir: string): string {
    const lines: string[] = [];
    for (const entry of this.dirs) {
      if (entry.startsWith(`${dir}/`)) lines.push(`d|755|${entry.slice(dir.length + 1)}\n`);
    }
    for (const [path, file] of this.files) {
      if (path.startsWith(`${dir}/`)) {
        lines.push(`f|${file.executable ? "755" : "644"}|${path.slice(dir.length + 1)}\n`);
      }
    }
    return lines.join("");
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

class ComputeSdkEmulatedProvider implements ComputeSdkProvider {
  readonly name = "computesdk-emulator";
  readonly sandboxes = new Map<string, ComputeSdkEmulatedSandbox>();
  private sequence = 0;
  private readonly respond = desktopCommandResponder();
  readonly created: Record<string, unknown>[] = [];

  sandbox = {
    create: async (options?: Record<string, unknown>) => {
      this.created.push(options ?? {});
      const box = new ComputeSdkEmulatedSandbox(`csdk-${++this.sequence}`, this.respond);
      this.sandboxes.set(box.sandboxId, box);
      return box;
    },
    getById: async (sandboxId: string) => {
      const box = this.sandboxes.get(sandboxId);
      return box?.alive ? box : null;
    },
    destroy: async (sandboxId: string) => {
      const box = this.sandboxes.get(sandboxId);
      if (box) box.alive = false;
    },
  };
}

/** A ComputeSdkSandboxProvider backed by the in-memory backend. */
export function emulatedComputeSdk(backend = "e2b") {
  const emulator = new ComputeSdkEmulatedProvider();
  return {
    emulator,
    provider: () => new ComputeSdkSandboxProvider({ provider: emulator, backend }),
  };
}
