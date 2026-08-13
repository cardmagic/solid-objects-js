import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor } from "../src/actor.js"
import { buildSettings, validateComponent } from "../src/configuration.js"
import {
  actorState,
  hydrateActor,
  initialStateFor,
  migrateState,
  validateDefinition,
} from "../src/definition.js"
import { InvalidActor, StateMigrationError } from "../src/errors.js"
import type { ActorReference } from "../src/reference.js"
import { sqlite } from "../src/database/sqlite.js"
import type { JsonObject } from "../src/types.js"

class VersionedActor extends Actor {
  static override readonly actorType = "VersionedActor"
  static override readonly stateVersion = 3
  static override readonly migrations = [
    {
      from: 1,
      to: 2,
      migrate: (state: JsonObject): JsonObject => ({
        ...state,
        count: state.value ?? 0,
        label: "migrated",
      }),
    },
    {
      from: 2,
      to: 3,
      migrate: (state: JsonObject): JsonObject => ({ ...state }),
    },
  ]

  count = 0
  label = "new"

  get summary(): string {
    return `${this.label}:${this.count}`
  }

  increment(): void {
    this.count += 1
  }
}

class InvalidArgumentsActor extends Actor {
  static override readonly actorType = "InvalidArgumentsActor"

  combine(_first: string, _second: string): void {}
}

describe("actor definitions", () => {
  it("does not expose positional actor arguments through typed references", () => {
    expectTypeOf<ActorReference<InvalidArgumentsActor>["combine"]>().toEqualTypeOf<never>()
  })

  it("discovers public state, messages, and getters from an ordinary class", () => {
    const definition = validateDefinition(VersionedActor)

    expect(definition).toMatchObject({
      type: "VersionedActor",
      stateKeys: ["count", "label"],
      operations: ["increment"],
      queries: ["count", "label", "summary"],
      stateVersion: 3,
    })
    expect(initialStateFor(definition)).toEqual({ count: 0, label: "new" })
  })

  it("hydrates persisted state without sharing mutable values", () => {
    const definition = validateDefinition(VersionedActor)
    const state = { count: 4, label: "stored" }

    const actor = hydrateActor({ definition, actorId: "actor-1", state })
    actor.increment()

    expect(actor.actorId).toBe("actor-1")
    expect(actor.summary).toBe("stored:5")
    expect(state).toEqual({ count: 4, label: "stored" })
    expect(actorState(actor, definition.stateKeys)).toEqual({ count: 5, label: "stored" })
  })

  it("runs consecutive migrations and fills new defaults", () => {
    class Migrated extends Actor {
      static override readonly actorType = "Migrated"
      static override readonly stateVersion = 2
      static override readonly migrations = [
        {
          from: 1,
          to: 2,
          migrate: (state: JsonObject): JsonObject => ({ count: state.oldCount ?? 0 }),
        },
      ]

      count = 0
      label = "default"
    }
    const definition = validateDefinition(Migrated)

    expect(migrateState({ definition, storedVersion: 1, storedState: { oldCount: 3 } })).toEqual({
      count: 3,
      label: "default",
    })
  })

  it("rejects missing, duplicate, and invalid migration paths", () => {
    const missing = validateDefinition(
      class extends Actor {
        static override readonly actorType = "MissingMigration"
        static override readonly stateVersion = 2
      },
    )
    expect(() => migrateState({ definition: missing, storedVersion: 1, storedState: {} })).toThrow(
      StateMigrationError,
    )
    expect(() => migrateState({ definition: missing, storedVersion: 3, storedState: {} })).toThrow(
      "newer than code version",
    )

    class Duplicate extends Actor {
      static override readonly actorType = "DuplicateMigration"
      static override readonly migrations = [
        { from: 1, to: 2, migrate: () => ({}) },
        { from: 1, to: 2, migrate: () => ({}) },
      ]
    }
    expect(() => validateDefinition(Duplicate)).toThrow("defined more than once")

    class Skipping extends Actor {
      static override readonly actorType = "SkippingMigration"
      static override readonly migrations = [{ from: 1, to: 3, migrate: () => ({}) }]
    }
    expect(() => validateDefinition(Skipping)).toThrow("advance exactly one version")
  })

  it("rejects actor members that collide with reference behavior", () => {
    class Collision extends Actor {
      static override readonly actorType = "Collision"

      send(): void {}
    }

    expect(() => validateDefinition(Collision)).toThrow(/"send" conflicts with the reference API/)
  })

  it("rejects invalid payload broadcast declarations", () => {
    class InvalidPayloadActor extends Actor {
      static override readonly actorType = "InvalidPayloadActor"
      static override readonly payloads = { summary: "not a function" }
    }

    expect(() => validateDefinition(InvalidPayloadActor)).toThrow(
      'actor payload "summary" must be a function',
    )
  })

  it("rejects invalid actor types, state versions, and member names", () => {
    class InvalidType extends Actor {
      static override readonly actorType = "invalid actor"
    }
    expect(() => validateDefinition(InvalidType)).toThrow(InvalidActor)

    class InvalidVersion extends Actor {
      static override readonly actorType = "InvalidVersion"
      static override readonly stateVersion = 0
    }
    expect(() => validateDefinition(InvalidVersion)).toThrow("positive safe integer")

    class InvalidMember extends Actor {
      static override readonly actorType = "InvalidMember"
    }
    Object.defineProperty(InvalidMember.prototype, "invalid-name", { value: () => {} })
    expect(() => validateDefinition(InvalidMember)).toThrow("invalid actor member name")
  })
})

describe("runtime configuration", () => {
  it("uses deny-by-default policies", async () => {
    const database = sqlite({ path: ":memory:" })
    const settings = buildSettings({ database })

    expect(
      await settings.authorizeMessage({
        actorType: "Counter",
        actorId: "one",
        operation: "increment",
        arguments: {},
        authorizationContext: undefined,
      }),
    ).toBe(false)
    await database.close()
  })

  it("validates prefixes, leases, role counts, and components", async () => {
    const database = sqlite({ path: ":memory:" })

    expect(() => buildSettings({ database, tableNamePrefix: "Invalid-" })).toThrow(
      "tableNamePrefix",
    )
    expect(() =>
      buildSettings({
        database,
        leaseDurationMilliseconds: 10,
        leaseRenewalIntervalMilliseconds: 10,
      }),
    ).toThrow("must exceed")
    expect(() => buildSettings({ database, idleDeactivationTimeoutMilliseconds: -1 })).toThrow(
      "must be non-negative",
    )
    expect(() => buildSettings({ database, maxActivationDurationMilliseconds: 0 })).toThrow(
      "maxActivationDurationMilliseconds must be positive",
    )
    expect(() => buildSettings({ database, shutdownTimeoutMilliseconds: 0 })).toThrow(
      "shutdownTimeoutMilliseconds must be positive",
    )
    expect(() => buildSettings({ database, workerCount: -1 })).toThrow("non-negative integer")
    expect(() =>
      buildSettings({
        database,
        workerCount: 0,
        effectWorkerCount: 0,
        reminderSchedulerCount: 0,
        retentionIntervalMilliseconds: 0,
        deadProcessCleanupIntervalMilliseconds: 0,
      }),
    ).toThrow("at least one runtime role")
    expect(() => buildSettings({ database, retentionIntervalMilliseconds: -1 })).toThrow(
      "retentionIntervalMilliseconds must be non-negative",
    )
    expect(() => buildSettings({ database, deadProcessCleanupIntervalMilliseconds: -1 })).toThrow(
      "deadProcessCleanupIntervalMilliseconds must be non-negative",
    )
    expect(() => validateComponent({} as never)).toThrow("must implement run")

    await database.close()
  })
})
