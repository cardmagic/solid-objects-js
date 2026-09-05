import { AsyncLocalStorage } from "node:async_hooks"
import { registerContextStoreFactory } from "../platform/context-store.js"

registerContextStoreFactory(<Store>() => new AsyncLocalStorage<Store>())
