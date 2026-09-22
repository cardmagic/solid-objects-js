import { afterEach, describe, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import type {
  Database,
  DatabaseConnection,
  DatabaseFamily,
  DatabaseTransactionOptions,
} from "../src/database/types.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import {
  InProcessWakeUpAdapter,
  type NotificationWakeUpAdapter,
  type WakeUpAdapter,
  type WakeUpRole,
  type WakeUpSetting,
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
  readonly family: DatabaseFamily
  readonly schemaIdentity: string
  readonly adapters: ProbeWakeUpAdapter[] = []
  readonly notifiedChannels: string[] = []

  constructor(
    private readonly options: {
      database: Database
      delivers: boolean
      refuses?: boolean
      unreachable?: boolean
      family?: DatabaseFamily
    },
  ) {
    this.family = options.family ?? "postgresql"
    this.schemaIdentity = options.database.schemaIdentity
  }

  wakeUp(options: { channelPrefix?: string } = {}): NotificationWakeUpAdapter {
    if (this.options.refuses) throw new Error("this database refuses a notification adapter")
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
    if (this.options.unreachable) return Promise.reject(new Error("the database is unreachable"))
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
      run: (sql, parameters = []) => {
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

class SelectionCounter extends Actor {
  static override readonly actorType = "WakeUpSelectionCounter"

  count = 0

  increment(): void {
    this.count += 1
  }
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  delete process.env["SOLID_OBJECTS_REDIS_URL"]
})

function selectionOptions(options: { database: Database; setting?: WakeUpSetting }) {
  return {
    setting: options.setting ?? "automatic",
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

  it("opts out of selection when in_process is requested", async () => {
    const database = sqlite({ path: ":memory:" })

    const selected = await selectWakeUp(selectionOptions({ database, setting: "in_process" }))

    expect(selected.capability.adapter).toBe("in_process")
    expect(selected.capability.crossesProcesses).toBe(false)
    expect(selected.capability.reason).toMatch(/requested/i)
    await database.close()
  })

  it("selects redis on any database when a url is set", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true })
    process.env["SOLID_OBJECTS_REDIS_URL"] = "redis://127.0.0.1:6379/15"

    const selected = await selectWakeUp(selectionOptions({ database }))

    expect(selected.capability.adapter).toBe("redis")
    expect(selected.capability.crossesProcesses).toBe(true)
    expect(database.adapters).toHaveLength(0)
    await selected.adapter.close()
    await database.close()
  })

  it("polls when the database cannot answer the probe", async () => {
    const inner = sqlite({ path: ":memory:" })
    const database = new NotifyingDatabase({ database: inner, delivers: true, unreachable: true })

    const selected = await selectWakeUp(selectionOptions({ database }))

    expect(selected.capability.adapter).toBe("polling")
    expect(selected.capability.crossesProcesses).toBe(false)
    await database.close()
  })

  it("polls and warns when a requested adapter has no notification channel", async () => {
    const database = sqlite({ path: ":memory:" })
    const warnings: { event?: string }[] = []
    const logger = { ...silentLogger, warn: (entry: { event?: string }) => warnings.push(entry) }

    const selected = await selectWakeUp({
      ...selectionOptions({ database, setting: "postgresql" }),
      logger,
    })

    expect(selected.capability.adapter).toBe("polling")
    expect(selected.capability.reason).toMatch(/notification channel/i)
    expect(warnings.map(({ event }) => event)).toEqual(["solid_objects.wake_up.unavailable"])
    await database.close()
  })

  it("selects a requested name without probing", async () => {
    const database = sqlite({ path: ":memory:" })
    process.env["SOLID_OBJECTS_REDIS_URL"] = "redis://127.0.0.1:6379/15"

    const selected = await selectWakeUp(selectionOptions({ database, setting: "redis" }))

    expect(selected.capability.adapter).toBe("redis")
    expect(selected.capability.crossesProcesses).toBe(true)
    expect(selected.capability.reason).toMatch(/requested/i)
    await selected.adapter.close()
    await database.close()
  })

  it("polls and warns when redis is requested without a url", async () => {
    const database = sqlite({ path: ":memory:" })
    const warnings: { event?: string }[] = []
    const logger = { ...silentLogger, warn: (entry: { event?: string }) => warnings.push(entry) }

    const selected = await selectWakeUp({
      ...selectionOptions({ database, setting: "redis" }),
      logger,
    })

    expect(selected.capability.adapter).toBe("polling")
    expect(selected.capability.reason).toMatch(/SOLID_OBJECTS_REDIS_URL/)
    expect(warnings.map(({ event }) => event)).toEqual(["solid_objects.wake_up.unavailable"])
    await database.close()
  })

  it("refuses a configured adapter that cannot notify", () => {
    const adapter: WakeUpAdapter = {
      watch: () => ({ wait: () => Promise.resolve(false) }),
      notify: () => undefined,
      close: () => undefined,
    }
    Reflect.deleteProperty(adapter, "notify")

    expect(() => configure({ database: sqlite({ path: ":memory:" }), wakeUp: adapter })).toThrow(
      /must implement notify/,
    )
  })

  it("refuses an unknown name when the configuration is built", () => {
    expect(() =>
      configure({
        database: sqlite({ path: ":memory:" }),
        wakeUp: "carrier_pigeon" as WakeUpSetting,
      }),
    ).toThrow(/carrier_pigeon/)
  })

  it("refuses an unknown name rather than polling quietly", async () => {
    const database = sqlite({ path: ":memory:" })

    await expect(
      selectWakeUp({
        ...selectionOptions({ database }),
        setting: "carrier_pigeon" as WakeUpSetting,
      }),
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
    expect(selected.adapter.defaultCapability?.adapter).toBe("in_process")
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
    const warnings: { event?: string }[] = []
    const logger = { ...silentLogger, warn: (entry: { event?: string }) => warnings.push(entry) }

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

  it("reports a selection that cannot run once rather than on every commit", async () => {
    const errors: { event?: string }[] = []
    const logger = { ...silentLogger, error: (entry: { event?: string }) => errors.push(entry) }
    const inner = sqlite({ path: ":memory:" })
    runtime = configure({
      database: new NotifyingDatabase({
        database: inner,
        delivers: true,
        refuses: true,
        family: "sqlite",
      }),
      wakeUp: "postgresql",
      logger,
      authorizeMessage: () => true,
    })
    runtime.register(SelectionCounter)
    await runtime.install()

    await runtime.ref(SelectionCounter, "one").send.increment()
    await runtime.ref(SelectionCounter, "one").send.increment()
    await vi.waitFor(() =>
      expect(errors.some(({ event }) => event === "solid_objects.wake_up.selection_failed")).toBe(
        true,
      ),
    )

    expect(
      errors.filter(({ event }) => event === "solid_objects.wake_up.selection_failed"),
    ).toHaveLength(1)
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
