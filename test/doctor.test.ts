import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined

class UnrelatedActor extends Actor {
  static override readonly actorType = "DoctorUnrelatedActor"

  run(): void {}
}

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("runtime doctor", () => {
  it("verifies an installed workerless runtime with a durable round trip", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    const report = await runtime.doctor.run()

    expect(report.healthy).toBe(true)
    expect(check(report, "configuration").status).toBe("pass")
    expect(check(report, "schema")).toMatchObject({
      status: "pass",
      details: { versions: [1, 2, 3, 4, 5, 6] },
    })
    expect(check(report, "authorization").status).toBe("pass")
    expect(check(report, "database").status).toBe("pass")
    expect(check(report, "runtime").status).toBe("info")
    expect(check(report, "roundTrip").status).toBe("pass")
    const probes = await runtime.settings.database.connection((connection) =>
      connection.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM ${runtime?.repository.table("instances")}
         WHERE actor_type = ?`,
        ["solid_objects_doctor"],
      ),
    )
    expect(Number(probes?.count)).toBe(0)
  })

  it("warns about authorization policies that were not explicitly configured", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeAdministration: () => true,
    })
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(report.healthy).toBe(true)
    expect(check(report, "authorization")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("authorizeMessage"),
    })
    expect(check(report, "roundTrip").status).toBe("skip")
  })

  it("warns when sensitive policies allow a neutral context", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeQuery: () => true,
      authorizeDestroy: () => true,
      authorizeAdministration: () => true,
      authorizeSubscription: () => true,
    })
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(check(report, "authorization")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("authorizeDestroy"),
      details: {
        configured: expect.any(Object),
        neutralContext: expect.objectContaining({
          authorizeDestroy: "allow",
          authorizeSubscription: "allow",
          authorizeAdministration: "allow",
        }),
      },
    })
  })

  it("warns when every policy denies a neutral context", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => false,
      authorizeQuery: () => false,
      authorizeDestroy: () => false,
      authorizeAdministration: () => false,
      authorizeSubscription: () => false,
    })
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(check(report, "authorization")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("all five policies denied"),
    })
  })

  it("confines policies that need application context", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => {
        throw new Error("request context required")
      },
      authorizeQuery: () => false,
      authorizeDestroy: () => false,
      authorizeAdministration: () => false,
      authorizeSubscription: () => false,
    })
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(check(report, "authorization")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("authorizeMessage"),
      details: {
        configured: expect.any(Object),
        neutralContext: expect.objectContaining({ authorizeMessage: "unknown" }),
      },
    })
  })

  it("fails schema verification and skips dependent checks when tables are missing", async () => {
    runtime = configuredRuntime()

    const report = await runtime.doctor.run()

    expect(report.healthy).toBe(false)
    expect(check(report, "schema")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("missing tables"),
    })
    expect(check(report, "runtime").status).toBe("skip")
    expect(check(report, "roundTrip").status).toBe("skip")
  })

  it("reports live runtime roles by kind", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await runtime.repository.registerProcess("worker-one", "worker")
    await runtime.repository.registerProcess("effects-one", "effect_worker")

    const report = await runtime.doctor.run({ roundTrip: "skip" })

    expect(check(report, "runtime")).toMatchObject({
      status: "pass",
      details: { roles: { effect_worker: 1, worker: 1 } },
    })
  })

  it("does not consume unrelated ready work during its round trip", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    const unrelated = await UnrelatedActor.ref("waiting").send.run()

    const report = await runtime.doctor.run()

    expect(check(report, "roundTrip").status).toBe("pass")
    expect(await unrelated.status()).toBe("ready")
  })
})

function check(report: Awaited<ReturnType<SolidObjectsRuntime["doctor"]["run"]>>, name: string) {
  const result = report.checks.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`missing doctor check ${name}`)
  return result
}

function configuredRuntime(): SolidObjectsRuntime {
  return configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => false,
    authorizeAdministration: () => false,
    authorizeSubscription: () => false,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
  })
}
