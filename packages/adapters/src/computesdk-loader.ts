import { createRequire } from "node:module";
import type { ComputeSdkProvider } from "./computesdk-sandbox.js";

const require = createRequire(import.meta.url);

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Provider package names are kebab-case; factory exports are camelCase (cloud-run → cloudRun). */
function camelCase(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function pickFactory(mod: Record<string, unknown>, id: string): () => ComputeSdkProvider {
  const candidates = [mod[camelCase(id)], mod[id], mod.default];
  const named = candidates.find((candidate) => typeof candidate === "function");
  if (named) return named as () => ComputeSdkProvider;
  const callable = Object.entries(mod).find(
    ([key, value]) => !key.startsWith("__") && typeof value === "function",
  );
  if (callable) return callable[1] as () => ComputeSdkProvider;
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
    mod = require(`@computesdk/${id}`) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND") {
      throw new Error(
        `unknown COMPUTESDK_PROVIDER "${id}": add @computesdk/${id} to @rakazo/adapters dependencies`,
      );
    }
    throw error;
  }
  return pickFactory(mod, id)();
}
