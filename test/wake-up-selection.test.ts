import { afterEach, describe, expect, it, vi } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import type {
  Database,
  DatabaseConnection,
  DatabaseFamily,
  DatabaseTransactionOptions,
  RunResult,
} from "../src/database/types.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import {
  InProcessWakeUpAdapter,
  type NotificationWakeUpAdapter,
  type WakeUpAdapter,
  type WakeUpRole,
  type WakeUpWatch,
} from "../src/wake-up.js"
import { selectWakeUp } from "../src/wake-up-selection.js"

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

class ProbeWakeUpAdapter implements NotificationWakeUpAdapter {
  closed = false
  readonly watchedRoles: WakeUpRole[] = []

  constructor(private readonly options: { delivers: boolean; channelPrefix: string }) {}

  channelFor(role: WakeUpRole): string {
    return `${this.options.channelPrefix}_${role}`
  }

  watch(role: WakeUpRole): WakeUpWatch {
    this.watchedRoles.push(role)
    return { wait: () => Promise.resolve(this.options.delivers) }
  }

  notify(): void {}

  close(): void {
    this.closed = true
  }
}

class NotifyingDatabase implements Database {
  readonly family: DatabaseFamily = "postgresql"
  readonly schemaIdentity: string
  readonly adapters: ProbeWakeUpAdapter[] = []
  readonly notifiedChannels: string[] = []

  constructor(private readonly options: { database: Database; delivers: boolean }) {
    this.schemaIdentity = options.database.schemaIdentity
  }

  wakeUp(options: { channelPrefix?: string } = {}): NotificationWakeUpAdapter {
    const adapter = new ProbeWakeUpAdapter({
      delivers: this.options.delivers,
      channelPrefix: options.channelPrefix ?? "solid_objects",
    })
    this.adapters.push(adapter)
    return adapter
  }

  connection<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
  ): Promise<Result> {
    return this.options.database.connection((connection) => callback(this.intercept(connection)))
  }

  transaction<Result>(
    callback: (connection: DatabaseConnection) => Promise<Result>,
    options?: DatabaseTransactionOptions,
  ): Promise<Result> {
    return this.options.database.transaction(callback, options)
  }

  close(): Promise<void> {
    return this.options.database.close()
  }

  private intercept(connection: DatabaseConnection): DatabaseConnection {
    return {
      run: (sql: string, parameters: readonly unknown[] = []): Promise<RunResult> => {
        if (!sql.includes("pg_notify")) return connection.run(sql, parameters)
        this.notifiedChannels.push(String(parameters[0]))
        return Promise.resolve({ changes: 0 })
      },
      get: (sql, parameters) => connection.get(sql, parameters),
      all: (sql, parameters) => connection.all(sql, parameters),
      nowMilliseconds: () => connection.nowMilliseconds(),
    }
  }
}

class CustomWakeUpAdapter implements WakeUpAdapter {
  watch(): WakeUpWatch {
    return { wait: () => Promise.resolve(false) }
  }

  notify(): void {}

  close(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  delete process.env["SOLID_OBJECTS_REDIS_URL"]
})

function selectionOptions(options: { database: Database; setting?: unknown }) {
  return {
    setting: (options.setting ?? "automatic") as never,
    database: options.database,
    idlePollingIntervalMilliseconds: 1_000,
    logger: silentLogger,
  }
}

describe("wake-up selection", () => {
  it("keeps an explicitly configured adapter", async () => {
    const configured = new InProcessWakeUpAdapter()
    const database = sqlite({ path: ":memory:" })

    const selected = await selectWakeUp(selectionOptions({ database, setting: configured }))

    expect(selected.adapter).toBe(configured)
    await database.close()
  })

  it("keeps the capability a configured adapter reports about itself", async () => {
    const database = sqlite({ path: ":memory:" })

    const selected = await selectWakeUp(
      selectionOptions({ database, setting: new InProcessWakeUpAdapter() }),
    )

    expect(selected.capability.adapter).toBe("in_process")
    expect(selected.capability.crossesProcesses).toBe(false)
    await database.close()
  })

  it("records a configured adapter that reports no capability as configured", async () => {
    const database = sqlite({ path: ":memory:" })

    const selected = await selectWakeUp(
      selectionOptions({ database, setting: new CustomWakeUpAdapter() }),
    )

    expect(selected.capability.adapter).toBe("configured")
    expect(selected.capability.crossesProcesses).toBe(true)
    await database.close()
  })

  it("selects where the runtime defines no process global, as a browser does not", async () => {
    const database = sqlite({ path: ":memory:" })
    vi.stubGlobal("process", undefined)
    try {
      const selected = await selectWakeUp(selectionOptions({ database }))

      expect(selected.capability.adapter).toBe("polling")
    } finally {
      vi.unstubAllGlobals()
      await database.close()
    }
  })

  it("refuses an unknown name rather than polling quietly", async () => {
    const database = sqlite({ path: ":memory:" })

    await expect(
      selectWakeUp(selectionOptions({ database, setting: "carrier_pigeon" })),
    ).rejects.toThrow(/carrier_pigeon/)
    await database.close()
  })

  it("polls on a database without a notification channel", async () => {
    const database = sqlite({ path: ":memory:" })

    const selected = await selectWakeUp(selectionOptions({ database }))

    expect(selected.capability.adapter).toBe("polling")
    expect(selected.capability.crossesProcesses).toBe(false)
    expect(selected.capability.measuredFloorMilliseconds).toBe(1_000)
    expect(selected.capability.reason).toMatch(/no notification channel/i)
    await database.close()
  })

  it("selects PostgreSQL notifications when a probe notification arrives", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })

    const selected = await selectWakeUp(selectionOptions({ database }))

    expect(selected.capability.adapter).toBe("postgresql_notify")
    expect(selected.capability.crossesProcesses).toBe(true)
    expect(selected.capability.reason).toMatch(/probe notification arrived/i)
    await database.close()
  })

  it("notifies the probe channel from the database rather than from the listener", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })

    await selectWakeUp(selectionOptions({ database }))

    expect(database.notifiedChannels).toHaveLength(1)
    expect(database.notifiedChannels[0]).not.toBe("solid_objects_actors")
    expect(database.adapters[0]?.closed).toBe(true)
    await database.close()
  })

  it("polls when a probe notification does not arrive", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: false })

    const selected = await selectWakeUp(selectionOptions({ database }))

    expect(selected.capability.adapter).toBe("polling")
    expect(selected.capability.crossesProcesses).toBe(false)
    expect(selected.capability.reason).toMatch(/pooler/i)
    await database.close()
  })

  it("warns once about a pooled PostgreSQL session", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: false })
    const warnings: unknown[] = []
    const logger = { ...silentLogger, warn: (entry: unknown) => warnings.push(entry) }

    await selectWakeUp({ ...selectionOptions({ database }), logger })

    expect(warnings).toHaveLength(1)
    await database.close()
  })
})

describe("runtime wake-up selection", () => {
  it("selects once when callers race for the adapter", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })
    runtime = configure({ database, authorizeMessage: () => true })

    const selections = await Promise.all(Array.from({ length: 8 }, () => runtime?.wakeUpAdapter()))

    expect(database.adapters).toHaveLength(2)
    expect(new Set(selections).size).toBe(1)
  })

  it("does not select again after the runtime closes", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })
    const closing = configure({ database, authorizeMessage: () => true })
    const selected = await closing.wakeUpAdapter()
    await closing.close()

    expect(await closing.wakeUpAdapter()).toBe(selected)
    expect(database.adapters).toHaveLength(2)
  })

  it("reports the capability of the adapter that is installed", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
    })

    const capability = await runtime.wakeUpCapability()

    expect(capability.adapter).toBe("polling")
    expect(capability.crossesProcesses).toBe(false)
  })

  it("warns in the doctor about a configured in-process adapter", async () => {
    runtime = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeAdministration: () => true,
      wakeUp: new InProcessWakeUpAdapter(),
    })
    await runtime.install()

    const report = await runtime.doctor.run({ roundTrip: "skip" })
    const wakeUp = report.checks.find(({ name }) => name === "wakeUp")

    expect(wakeUp?.status).toBe("warn")
    expect(wakeUp?.message).toMatch(/in_process/)
  })

  it("passes the doctor when the installed adapter crosses processes", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })
    runtime = configure({ database, authorizeAdministration: () => true })

    const report = await runtime.doctor.run({ roundTrip: "skip" })
    const wakeUp = report.checks.find(({ name }) => name === "wakeUp")

    expect(wakeUp?.status).toBe("pass")
    expect(wakeUp?.message).toMatch(/postgresql_notify/)
  })
})
