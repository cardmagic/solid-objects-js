import { afterEach, expect, it, vi } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { postgresql } from "../src/database/postgresql.js"
import { mysql } from "../src/database/mysql.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { receiveTransmitEnvelope, registerTransmit, TRANSMIT_EFFECT } from "../src/transmit.js"

class Sender extends Actor {
  static override readonly actorType = "OrderedTransmit"

  stage(): void {
    const identifiers = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("ffffffff-ffff-4fff-8fff-ffffffffffff")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000000")
    try {
      this.emit(TRANSMIT_EFFECT, { arguments: { operation: "append", arguments: { value: 1 } } })
      this.emit(TRANSMIT_EFFECT, { arguments: { operation: "append", arguments: { value: 2 } } })
    } finally {
      identifiers.mockRestore()
    }
  }

  stageFluent(): void {
    this.transmit().append({ value: 1 })
    this.transmit().append({ value: 2 })
  }

  append(_arguments: { value: number }): void {}
}

class Receiver extends Actor {
  static override readonly actorType = "OrderedTransmit"
  values: number[] = []

  append({ value }: { value: number }): void {
    this.values.push(value)
  }
}

const runtimes: SolidObjectsRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes) {
    await runtime.repository.resetForTesting()
    await runtime.close()
  }
  runtimes.length = 0
})

async function start(prefix: string): Promise<SolidObjectsRuntime> {
  const connectionString = process.env.SOLID_OBJECTS_DATABASE_URL
  const database = connectionString?.startsWith("postgresql:")
    ? postgresql({ connectionString })
    : connectionString?.startsWith("mysql:")
      ? mysql({ connectionString })
      : sqlite({ path: ":memory:" })
  const runtime = createRuntime({
    database,
    tableNamePrefix: prefix,
    wakeUp: "in_process",
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    retryDelayMilliseconds: () => 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

it("preserves staging order within a message through delivery retries", async () => {
  const sender = await start("transmit_order_sender_")
  const receiver = await start("transmit_order_receiver_")
  sender.register(Sender)
  receiver.register(Receiver)
  let failures = 1
  registerTransmit({
    runtime: sender,
    deliver: async (envelope) => {
      if (envelope.arguments.value === 1 && failures-- > 0) throw new Error("offline")
      await receiveTransmitEnvelope({ runtime: receiver, envelope })
    },
  })
  await sender.ref(Sender, "one").stage()
  await sender.testing.drain({ roles: ["effects"], maxPasses: 20 })
  await receiver.testing.drain({ roles: ["actors"] })
  expect(await receiver.ref(Receiver, "one").snapshot()).toEqual({ values: [1, 2] })
})

for (const migrationState of ["absent", "interrupted"] as const) {
  it(`upgrades ${migrationState} effect positions without changing pending work`, async () => {
    const runtime = await start("transmit_order_upgrade_")
    runtime.register(Sender)
    await runtime.ref(Sender, "legacy").stageFluent()
    const effects = runtime.repository.table("effects")
    const migrations = runtime.repository.table("schema_migrations")
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(`DELETE FROM ${migrations} WHERE version = 14`)
      if (migrationState === "absent")
        await connection.run(`ALTER TABLE ${effects} DROP COLUMN position`)
    })
    await runtime.install()
    await runtime.install()
    await runtime.ref(Sender, "new").stageFluent()
    const rows = await runtime.settings.database.connection((connection) =>
      connection.all<{ actor_id: string; position: number | bigint; status: string }>(
        `SELECT instances.actor_id, effects.position, effects.status FROM ${effects} effects JOIN ${runtime.repository.table("instances")} instances ON instances.id = effects.instance_id ORDER BY instances.actor_id, effects.position`,
      ),
    )
    expect(rows.map((row) => [row.actor_id, Number(row.position), row.status])).toEqual([
      ["legacy", 0, "pending"],
      ["legacy", migrationState === "absent" ? 0 : 1, "pending"],
      ["new", 0, "pending"],
      ["new", 1, "pending"],
    ])
  })
}
