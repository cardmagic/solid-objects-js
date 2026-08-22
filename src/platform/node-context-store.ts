import { AsyncLocalStorage } from "node:async_hooks"
import { registerContextStoreFactory } from "./context-store.js"

registerContextStoreFactory(() => new AsyncLocalStorage())
