import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with ComputeSDK identity. */
export class ComputeSdkSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "computesdk-emulator", kind: "computesdk" });
  }
}
