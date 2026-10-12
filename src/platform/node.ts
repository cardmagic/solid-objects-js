import { AsyncLocalStorage } from "node:async_hooks"
import { hostname } from "node:os"
import { registerContextStoreFactory } from "./context-store.js"
import { registerHostIdentity } from "./host-identity.js"
import { registerEventLoopYield } from "../yield-to-event-loop.js"

registerContextStoreFactory(<Store>() => new AsyncLocalStorage<Store>())
registerEventLoopYield(() => new Promise((resolve) => setTimeout(() => setImmediate(resolve), 0)))
registerHostIdentity({
  hostname: hostname(),
  hostProcessId: process.pid,
  runtimeVersion: process.version,
})
