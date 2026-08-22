import { registerContextStoreFactory } from "../platform/context-store.js"
import { registerHostIdentity } from "../platform/host-identity.js"
import { TurnContextStore } from "../platform/turn-context-store.js"

registerContextStoreFactory(() => new TurnContextStore())
registerHostIdentity({
  hostname: globalThis.location?.hostname ?? "browser",
  hostProcessId: randomHostProcessId(),
  runtimeVersion: "browser",
})

export { Actor, broadcastInvalidation, broadcastValue } from "../actor.js"
export { configure, createRuntime, SolidObjectsRuntime } from "../runtime.js"
export { VERSION } from "../version.js"
export {
  sqliteWasm,
  SQLiteWasmDatabase,
  type SQLiteWasmDatabaseOptions,
} from "../database/sqlite-wasm.js"
export {
  connectTabClient,
  startTabHost,
  type TabClient,
  type TabClientOptions,
  type TabHost,
  type TabHostOptions,
  type TabHostRuntimeHandle,
  type TabInvocation,
} from "./tab-host.js"
export {
  registerSyncBridge,
  SYNC_BRIDGE_EFFECT,
  type SyncBridgeOptions,
  type SyncEnvelope,
} from "../sync-bridge.js"

function randomHostProcessId(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] ?? 1
}
