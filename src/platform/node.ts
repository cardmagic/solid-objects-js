import { AsyncLocalStorage } from "node:async_hooks"
import { hostname } from "node:os"
import { registerContextStoreFactory } from "./context-store.js"
import { registerHostIdentity } from "./host-identity.js"

registerContextStoreFactory(<Store>() => new AsyncLocalStorage<Store>())
registerHostIdentity({
  hostname: hostname(),
  hostProcessId: process.pid,
  runtimeVersion: process.version,
})
