import { afterEach, describe, expect, it } from "vitest"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"
import { Inspection } from "../examples/guides/offline-first/server-inspection.js"
import { handleInspectionSync } from "../examples/guides/offline-first/sync-route.js"

const runtimes: SolidObjectsRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

async function serverRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = configure({
    database: sqlite({ path: ":memory:" }),
    authorizeQuery: () => true,
  })
  runtimes.push(runtime)
  runtime.register(Inspection)
  await runtime.install()
  return runtime
}

const envelope = {
  effectId: "effect-1",
  actorType: "Inspection",
  actorId: "site-12",
  operation: "record",
  arguments: { findingId: "finding-1", note: "Crack in the north wall" },
}

function syncRequest({ device, body }: { device: string | null; body: unknown }): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (device) headers.set("x-device", device)
  return new Request("https://example.test/inspections/sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

async function canWrite({
  request,
  envelope: received,
}: {
  request: Request
  envelope: { actorId: string }
}): Promise<boolean> {
  return request.headers.get("x-device") === "tablet-7" && received.actorId === "site-12"
}

async function findings(runtime: SolidObjectsRuntime): Promise<readonly unknown[]> {
  await runtime.testing.drain({ roles: ["actors"] })
  return (await runtime.ref(Inspection, "site-12").snapshot()).findings
}

describe("the inspection sync route", () => {
  it("refuses a device that it cannot authorize", async () => {
    const runtime = await serverRuntime()

    const response = await handleInspectionSync({
      request: syncRequest({ device: null, body: envelope }),
      runtime,
      canWrite,
    })

    expect(response.status).toBe(403)
    expect(await findings(runtime)).toEqual([])
  })

  it("applies a write from an authorized device", async () => {
    const runtime = await serverRuntime()

    const response = await handleInspectionSync({
      request: syncRequest({ device: "tablet-7", body: envelope }),
      runtime,
      canWrite,
    })

    expect(response.status).toBe(200)
    expect(await findings(runtime)).toEqual([
      { findingId: "finding-1", note: "Crack in the north wall" },
    ])
  })

  it("applies a repeated write once", async () => {
    const runtime = await serverRuntime()

    await handleInspectionSync({
      request: syncRequest({ device: "tablet-7", body: envelope }),
      runtime,
      canWrite,
    })
    const repeated = await handleInspectionSync({
      request: syncRequest({ device: "tablet-7", body: envelope }),
      runtime,
      canWrite,
    })

    expect(repeated.status).toBe(200)
    expect(await findings(runtime)).toHaveLength(1)
  })

  it("answers 422 for a write that can never apply", async () => {
    const runtime = await serverRuntime()
    const malformed = { ...envelope, operation: "" }

    const response = await handleInspectionSync({
      request: syncRequest({ device: "tablet-7", body: malformed }),
      runtime,
      canWrite,
    })

    expect(response.status).toBe(422)
  })
})
