import { env } from "cloudflare:test"
import { describe } from "vitest"
import { createRuntime, durableObjects } from "../../src/cloudflare/index.js"
import { portableRuntimeContract } from "../support/portable-runtime-contract.js"

describe("Durable Objects portable runtime contract", () => {
  portableRuntimeContract(() =>
    createRuntime({ backend: durableObjects({ namespace: env.ACTORS }) }),
  )
})
