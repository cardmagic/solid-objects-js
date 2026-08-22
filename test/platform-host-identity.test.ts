import { describe, expect, it } from "vitest"
import {
  HostIdentityMissing,
  hostIdentity,
  registerHostIdentity,
} from "../src/platform/host-identity.js"

describe("host identity registry", () => {
  it("throws a clear error before registration", () => {
    expect(() => hostIdentity()).toThrow(HostIdentityMissing)
  })

  it("returns the node identity after the node platform module loads", async () => {
    await import("../src/platform/node.js")
    const identity = hostIdentity()
    expect(identity.hostname.length).toBeGreaterThan(0)
    expect(identity.hostProcessId).toBe(process.pid)
    expect(identity.runtimeVersion).toBe(process.version)
  })

  it("lets a later registration replace the identity", () => {
    const replacement = { hostname: "browser-host", hostProcessId: 7, runtimeVersion: "browser" }
    registerHostIdentity(replacement)
    expect(hostIdentity()).toEqual(replacement)
  })
})
