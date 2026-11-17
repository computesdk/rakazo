import { createRequire } from "node:module";
import type { ComputeSdkProvider } from "./computesdk-sandbox.js";

const localRequire = createRequire(import.meta.url);

/**
 * Bundled entrypoints relocate this code (e.g. the api runs apps/api/dist/index.js),
 * where pnpm's layout no longer exposes @rakazo/adapters' dependencies. Anchor the
 * lookup at the installed @rakazo/adapters package itself, which every consumer of
 * the factory depends on, falling back to this file's own location for source runs.
 */
function providerModule(specifier: string): Record<string, unknown> {
  const anchors = [import.meta.url];
  let anchorError: unknown;
  try {
    anchors.push(localRequire.resolve("@rakazo/adapters"));
  } catch (error) {
    anchorError = error;
  }
  let lastError: unknown;
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      lastError = error;
    }
  }
  // A broken @rakazo/adapters install (unresolvable exports, bad metadata) is
  // the real failure; surface it rather than blaming the provider package.
  if (anchorError && (anchorError as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
    throw anchorError;
  }
  throw lastError;
}

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Provider package names are kebab-case; factory exports are camelCase (cloud-run → cloudRun). */
function camelCase(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function pickFactory(
  mod: Record<string, unknown>,
  id: string,
): (config?: Record<string, unknown>) => ComputeSdkProvider {
  const candidates = [mod[camelCase(id)], mod[id], mod.default];
  const named = candidates.find((candidate) => typeof candidate === "function");
  if (named) return named as (config?: Record<string, unknown>) => ComputeSdkProvider;
  const callable = Object.entries(mod).find(
    ([key, value]) => !key.startsWith("__") && typeof value === "function",
  );
  if (callable) return callable[1] as (config?: Record<string, unknown>) => ComputeSdkProvider;
  throw new Error(`@computesdk/${id} exports no provider factory`);
}

/**
 * Resolve a ComputeSDK backend by name against whatever @computesdk/<name>
 * packages are installed. Any new ComputeSDK provider works without adapter
 * changes — only the package needs to be a dependency.
 */
export function loadComputeSdkProvider(name: string): ComputeSdkProvider {
  const id = name.trim().toLowerCase();
  if (!PROVIDER_NAME_PATTERN.test(id)) {
    throw new Error(`invalid COMPUTESDK_PROVIDER "${name.trim()}"`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = providerModule(`@computesdk/${id}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND") {
      throw new Error(
        `unknown COMPUTESDK_PROVIDER "${id}": add @computesdk/${id} to @rakazo/adapters dependencies`,
      );
    }
    throw error;
  }
  // Empty config: every ComputeSDK provider falls back to its own env vars
  // (E2B_API_KEY, ...) and surfaces a vendor error when credentials are missing.
  return pickFactory(mod, id)({});
}
