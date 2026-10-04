import { daytona } from "@computesdk/daytona";
import { e2b } from "@computesdk/e2b";
import { modal } from "@computesdk/modal";
import { namespace } from "@computesdk/namespace";
import { runloop } from "@computesdk/runloop";
import type { ComputeSdkProvider } from "./computesdk-sandbox.js";

export interface ComputeSdkBackend {
  id: string;
  /** Env vars that must all be set for the backend to be usable. */
  requiredEnv: readonly string[];
  /** Alternative env vars, any one of which satisfies the requirement (e.g. token or token file). */
  anyEnv?: readonly string[];
  create(source: NodeJS.ProcessEnv): ComputeSdkProvider;
}

function trimmed(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = source[name]?.trim();
  return value || undefined;
}

/**
 * ComputeSDK backends that can host Rakazo computers: full Linux boxes with
 * apt (PREPARE_LINUX_DESKTOP), public port URLs for the screen gateway, and
 * getById reconnect for the stored providerRef.
 */
export const COMPUTESDK_BACKENDS: readonly ComputeSdkBackend[] = [
  {
    id: "e2b",
    requiredEnv: ["E2B_API_KEY"],
    create: (source) => e2b({ apiKey: trimmed(source, "E2B_API_KEY") }),
  },
  {
    id: "daytona",
    requiredEnv: ["DAYTONA_API_KEY"],
    create: (source) => daytona({ apiKey: trimmed(source, "DAYTONA_API_KEY") }),
  },
  {
    id: "namespace",
    requiredEnv: [],
    anyEnv: ["NSC_TOKEN", "NSC_TOKEN_FILE"],
    create: (source) =>
      namespace({
        token: trimmed(source, "NSC_TOKEN"),
        tokenFile: trimmed(source, "NSC_TOKEN_FILE"),
      }),
  },
  {
    id: "modal",
    requiredEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    create: (source) =>
      modal({
        tokenId: trimmed(source, "MODAL_TOKEN_ID"),
        tokenSecret: trimmed(source, "MODAL_TOKEN_SECRET"),
        environment: trimmed(source, "MODAL_ENVIRONMENT"),
      }),
  },
  {
    id: "runloop",
    requiredEnv: ["RUNLOOP_API_KEY"],
    create: (source) => runloop({ apiKey: trimmed(source, "RUNLOOP_API_KEY") }),
  },
];

export function computesdkBackend(id: string): ComputeSdkBackend | undefined {
  return COMPUTESDK_BACKENDS.find((backend) => backend.id === id.trim());
}

export function computesdkBackendIds(): string {
  return COMPUTESDK_BACKENDS.map((backend) => backend.id).join(" | ");
}

/** Env var names an operator can set to satisfy a backend's credential check. */
export function computesdkBackendEnvNames(backend: ComputeSdkBackend): string {
  return [...backend.requiredEnv, ...(backend.anyEnv ?? [])].join(" or ");
}

export function computesdkBackendReady(
  backend: ComputeSdkBackend,
  source: NodeJS.ProcessEnv,
): boolean {
  if (backend.requiredEnv.some((name) => !trimmed(source, name))) return false;
  if (backend.anyEnv && !backend.anyEnv.some((name) => trimmed(source, name))) return false;
  return true;
}
