import type { SandboxProvider } from "@rakazo/adapter-kit";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { BoxSandboxProvider } from "./box-sandbox.js";
import {
  computesdkBackend,
  computesdkBackendEnvNames,
  computesdkBackendIds,
  computesdkBackendReady,
} from "./computesdk-backends.js";
import { ComputeSdkSandboxEmulator } from "./computesdk-emulator.js";
import { ComputeSdkSandboxProvider } from "./computesdk-sandbox.js";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

export interface SandboxProviderOptions {
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  createosApiKey?: string;
  createosBaseUrl?: string;
  createosShape?: string;
  createosRootfs?: string;
  boxApiKey?: string;
  boxApiUrl?: string;
  /** ComputeSDK backend id (e2b | daytona | namespace | modal | runloop). */
  computesdkProvider?: string;
  computesdkImage?: string;
  computesdkTemplateId?: string;
  computesdkSnapshotId?: string;
  /** Env the ComputeSDK backend registry reads vendor credentials from. */
  computesdkEnv?: NodeJS.ProcessEnv;
  dataDir?: string;
}

function missingRemoteKey(
  provider: "e2b" | "daytona" | "createos" | "box" | "computesdk",
  envName: string,
): SandboxProvider {
  return new NoneSandboxProvider(
    `Computers unavailable: ${envName} is required for SANDBOX_PROVIDER=${provider}.`,
  );
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "none":
    case "":
      return new NoneSandboxProvider();
    case "e2b":
      if (!opts.e2bApiKey?.trim()) return missingRemoteKey("e2b", "E2B_API_KEY");
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "daytona":
      if (!opts.daytonaApiKey?.trim()) return missingRemoteKey("daytona", "DAYTONA_API_KEY");
      return new DaytonaSandboxProvider({
        apiKey: opts.daytonaApiKey,
        apiUrl: opts.daytonaApiUrl,
        target: opts.daytonaTarget,
      });
    case "createos":
      if (!opts.createosApiKey?.trim())
        return missingRemoteKey("createos", "CREATEOS_SANDBOX_API_KEY");
      return new CreateOSSandboxProvider({
        apiKey: opts.createosApiKey,
        baseUrl: opts.createosBaseUrl,
        shape: opts.createosShape,
        rootfs: opts.createosRootfs,
      });
    case "box":
      if (!opts.boxApiKey?.trim()) return missingRemoteKey("box", "BOX_API_KEY");
      return new BoxSandboxProvider({ apiKey: opts.boxApiKey, apiUrl: opts.boxApiUrl });
    case "computesdk": {
      const backendId = opts.computesdkProvider?.trim();
      if (!backendId) return missingRemoteKey("computesdk", "COMPUTESDK_PROVIDER");
      const backend = computesdkBackend(backendId);
      if (!backend) {
        return new NoneSandboxProvider(
          `Computers unavailable: unknown COMPUTESDK_PROVIDER "${backendId}". Use ${computesdkBackendIds()}.`,
        );
      }
      const env = opts.computesdkEnv ?? process.env;
      if (!computesdkBackendReady(backend, env)) {
        return missingRemoteKey("computesdk", computesdkBackendEnvNames(backend));
      }
      return new ComputeSdkSandboxProvider({
        provider: backend.create(env),
        backend: backend.id,
        image: opts.computesdkImage,
        templateId: opts.computesdkTemplateId,
        snapshotId: opts.computesdkSnapshotId,
      });
    }
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "e2b-emulator":
      return new ManagedSandboxEmulator();
    case "daytona-emulator":
      return new DaytonaSandboxEmulator();
    case "box-emulator":
      return new BoxSandboxEmulator();
    case "computesdk-emulator":
      return new ComputeSdkSandboxEmulator();
    case "desktop":
      return new DesktopSandboxProvider({
        root: opts.dataDir,
      });
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | e2b | daytona | createos | box | computesdk | e2b-emulator | daytona-emulator | box-emulator | computesdk-emulator | desktop | fake.`,
      );
  }
}
