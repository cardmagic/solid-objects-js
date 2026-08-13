import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import type { SolidObjectsConfiguration } from "../src/configuration.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import type { JsonObject } from "../src/types.js"

class ReconciledActor extends Actor {
  static override readonly actorType = "ReconciledActor"
  static override readonly stateVersion = 2
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: JsonObject): JsonObject => ({ status: state.legacyStatus ?? "new" }),
    },
  ]

  status = "new"

  setStatus({ status }: { status: string }): void {
    this.status = status
  }

  scheduleCheck(): void {
    this.schedule({ at: new Date(Date.now() + 86_400_000) }).check!()
  }

  check(): void {}
}

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("reconciliation reads", () => {
  it("denies reads when no administration policy is configured", async () => {
    runtime = configure({ database: sqlite({ path: ":memory:" }) })
    runtime.register(ReconciledActor)
    await runtime.install()

    await expect(runtime.reconciliation.active()).rejects.toBeInstanceOf(Unauthorized)
    await expect(
      runtime.reconciliation.statesFor({ actorType: ReconciledActor.actorType, actorIds: ["one"] }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })

  it("bulk reads migrated state by logical identity as immutable values", async () => {
    const authorizations: unknown[] = []
    runtime = configuredRuntime({
      authorizeAdministration: (input) => {
        authorizations.push(input)
        return true
      },
    })
    await runtime.install()
    await ReconciledActor.ref("one").setStatus({ status: "active" })
    await ReconciledActor.ref("two").setStatus({ status: "suspended" })
    const instance = await runtime.repository.findInstanceByIdentity(
      ReconciledActor.actorType,
      "one",
    )
    await runtime.settings.database.connection((connection) =>
      connection.run(
        `UPDATE ${runtime?.repository.table("instances")} SET state = ?, state_version = 1 WHERE id = ?`,
        [JSON.stringify({ legacyStatus: "migrated" }), instance?.id],
      ),
    )
    authorizations.length = 0

    const states = await runtime.reconciliation.statesFor({
      actorType: ReconciledActor.actorType,
      actorIds: ["one", "two", "missing"],
      authorizationContext: "operator",
    })

    expect(states).toEqual({
      one: { status: "migrated" },
      two: { status: "suspended" },
    })
    expect(Object.isFrozen(states)).toBe(true)
    expect(Object.isFrozen(states.one)).toBe(true)
    expect(authorizations).toEqual([
      {
        action: "statesFor",
        resource: "instances",
        authorizationContext: "operator",
      },
    ])
  })

  it("finds active quiet actors without mailbox work or scheduled reminders", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await ReconciledActor.ref("lost").setStatus({ status: "active" })
    await ReconciledActor.ref("recent").setStatus({ status: "active" })
    await ReconciledActor.ref("reminded").scheduleCheck()
    await ReconciledActor.ref("paused").setStatus({ status: "paused" })
    await ReconciledActor.ref("ready")
      .send.with({ availableAt: new Date(Date.now() + 86_400_000) })
      .check()
    const claimedMessage = await ReconciledActor.ref("claimed").send.check()
    await runtime.repository.registerProcess("claim-holder", "worker")
    const claimed = await runtime.repository.claim("claim-holder")
    expect(claimed?.message.id).toBe(claimedMessage.id)
    const old = Date.now() - 7 * 60 * 60 * 1_000
    await runtime.settings.database.connection(async (connection) => {
      await connection.run(
        `UPDATE ${runtime?.repository.table("instances")} SET updated_at_ms = ? WHERE actor_id != ?`,
        [old, "recent"],
      )
      await connection.run(
        `UPDATE ${runtime?.repository.table("instances")} SET paused = 1 WHERE actor_id = ?`,
        ["paused"],
      )
    })

    const quiet = await runtime.reconciliation.withoutPendingWork({
      actorType: ReconciledActor.actorType,
      quietForMilliseconds: 6 * 60 * 60 * 1_000,
    })
    const active = await runtime.reconciliation.active({ actorType: ReconciledActor.actorType })

    expect(quiet.items.map(({ actorId }) => actorId)).toEqual(["lost"])
    expect(active.items.map(({ actorId }) => actorId).sort()).toEqual([
      "claimed",
      "lost",
      "ready",
      "recent",
      "reminded",
    ])
  })

  it("finds actors whose application owners no longer exist", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    await ReconciledActor.ref("existing-owner").setStatus({ status: "active" })
    await ReconciledActor.ref("deleted-owner").setStatus({ status: "active" })

    const orphaned = await runtime.reconciliation.orphaned({
      actorType: ReconciledActor.actorType,
      ownerIds: ["existing-owner"],
    })

    expect(orphaned.items.map(({ actorId }) => actorId)).toEqual(["deleted-owner"])
  })

  it("bounds state reconciliation batches", async () => {
    runtime = configuredRuntime()
    await runtime.install()

    await expect(
      runtime.reconciliation.statesFor({
        actorType: ReconciledActor.actorType,
        actorIds: Array.from({ length: 1_001 }, (_value, index) => index),
      }),
    ).rejects.toThrow("at most 1000 actor IDs")
  })

  it("paginates large active sets with a stable cursor", async () => {
    runtime = configuredRuntime()
    await runtime.install()
    for (const actorId of ["one", "two", "three"]) {
      await ReconciledActor.ref(actorId).setStatus({ status: "active" })
    }

    const first = await runtime.reconciliation.active({
      actorType: ReconciledActor.actorType,
      limit: 2,
    })
    const cursor = first.nextCursor
    if (!cursor) throw new Error("expected another reconciliation page")
    const second = await runtime.reconciliation.active({
      actorType: ReconciledActor.actorType,
      cursor,
      limit: 2,
    })

    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(3)
  })
})

function configuredRuntime(
  overrides: Partial<SolidObjectsConfiguration> = {},
): SolidObjectsRuntime {
  return configure({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    pollingIntervalMilliseconds: 1,
    syncPollingIntervalMilliseconds: 1,
    ...overrides,
  })
}
