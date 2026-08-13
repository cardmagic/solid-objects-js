import { describe, expect, it, vi } from "vitest"
import {
  SolidObjectsComponentRegistry,
  type ComponentRefreshRequest,
  type ComponentRefreshResult,
  type InvalidationEnvelope,
} from "../src/browser/index.js"

describe("SolidObjectsComponentRegistry", () => {
  it("batches affected keyed components at one revision", async () => {
    const applications: string[] = []
    const refresh = vi.fn(async (request: ComponentRefreshRequest) =>
      request.components.map(({ target }) => ({ target, rendered: `rendered:${target}` })),
    )
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh,
      apply: ({ component, rendered }) => applications.push(`${component.target}:${rendered}`),
    })
    registry.register({
      actorType: "GameRoom",
      actorId: "table-1",
      target: "player-1",
      name: "player",
      key: 1,
      observes: ["playerOne"],
      batch: "playmat",
      strategy: "morph",
    })
    registry.register({
      actorType: "GameRoom",
      actorId: "table-1",
      target: "controls-1",
      name: "controls",
      key: 1,
      observes: ["controls"],
      batch: "playmat",
    })
    registry.register({
      actorType: "GameRoom",
      actorId: "table-1",
      target: "unaffected",
      name: "history",
      observes: ["history"],
      batch: "playmat",
    })

    registry.invalidate(invalidation({ revision: "4", observables: { playerOne: 1 } }))
    registry.invalidate(invalidation({ revision: "4", observables: { controls: true } }))
    await settle()

    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({
      actorType: "GameRoom",
      actorId: "table-1",
      instanceId: "instance-1",
      revision: "4",
      batch: "playmat",
    })
    expect(refresh.mock.calls[0]?.[0].components).toEqual([
      expect.objectContaining({ target: "player-1", key: "1", strategy: "morph" }),
      expect.objectContaining({ target: "controls-1", key: "1", strategy: "replace" }),
    ])
    expect(applications).toEqual(["player-1:rendered:player-1", "controls-1:rendered:controls-1"])
  })

  it("refreshes unbatched components independently", async () => {
    const refresh = vi.fn(async (request: ComponentRefreshRequest) =>
      request.components.map(({ target }) => ({ target, rendered: target })),
    )
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh,
      apply: () => {},
    })
    for (const name of ["summary", "details"]) {
      registry.register({
        actorType: "Cart",
        actorId: "one",
        target: name,
        name,
        observes: ["items"],
      })
    }

    registry.invalidate(
      invalidation({ actorType: "Cart", actorId: "one", observables: { items: 2 } }),
    )
    await settle()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh.mock.calls.map(([request]) => request.components[0]?.target).sort()).toEqual([
      "details",
      "summary",
    ])
  })

  it("aborts a superseded request and fences its result", async () => {
    const requests: ComponentRefreshRequest[] = []
    const pending: Array<{
      resolve: (results: readonly ComponentRefreshResult<string>[]) => void
    }> = []
    const applied: string[] = []
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: (request) => {
        requests.push(request)
        return new Promise((resolve) => pending.push({ resolve }))
      },
      apply: ({ rendered }) => applied.push(rendered),
    })
    registry.register({
      actorType: "Counter",
      actorId: "one",
      target: "count",
      name: "count",
      observes: ["count"],
      batch: "counter",
    })

    registry.invalidate(
      invalidation({
        actorType: "Counter",
        actorId: "one",
        revision: "1",
        observables: { count: 1 },
      }),
    )
    await settle()
    registry.invalidate(
      invalidation({
        actorType: "Counter",
        actorId: "one",
        revision: "2",
        observables: { count: 2 },
      }),
    )
    await settle()

    expect(requests[0]?.signal.aborted).toBe(true)
    pending[0]?.resolve([{ target: "count", rendered: "old" }])
    pending[1]?.resolve([{ target: "count", rendered: "new" }])
    await settle()

    expect(applied).toEqual(["new"])
  })

  it("resets revision fences for a new actor incarnation", async () => {
    const applied: string[] = []
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: async (request) => [
        { target: "count", rendered: `${request.instanceId}:${request.revision}` },
      ],
      apply: ({ rendered }) => applied.push(rendered),
    })
    registry.register({
      actorType: "Counter",
      actorId: "one",
      target: "count",
      name: "count",
      observes: ["count"],
    })

    registry.invalidate(
      invalidation({
        actorType: "Counter",
        actorId: "one",
        revision: "9",
        observables: { count: 9 },
      }),
    )
    await settle()
    registry.invalidate(
      invalidation({
        actorType: "Counter",
        actorId: "one",
        instanceId: "instance-2",
        revision: "1",
        observables: { count: 0 },
      }),
    )
    await settle()

    expect(applied).toEqual(["instance-1:9", "instance-2:1"])
  })

  it("keeps a new incarnation request cancellable after the old request settles", async () => {
    const requests: ComponentRefreshRequest[] = []
    const pending: Array<{
      resolve: (results: readonly ComponentRefreshResult<string>[]) => void
    }> = []
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: (request) => {
        requests.push(request)
        return new Promise((resolve) => pending.push({ resolve }))
      },
      apply: () => {},
    })
    registry.register({
      actorType: "Counter",
      actorId: "one",
      target: "count",
      name: "count",
      observes: ["count"],
    })
    const receive = (instanceId: string, revision: string) =>
      registry.invalidate(
        invalidation({
          actorType: "Counter",
          actorId: "one",
          instanceId,
          revision,
          observables: { count: revision },
        }),
      )

    receive("instance-1", "9")
    await settle()
    receive("instance-2", "1")
    await settle()
    pending[0]?.resolve([{ target: "count", rendered: "old incarnation" }])
    await settle()
    receive("instance-2", "2")
    await settle()

    expect(requests[1]?.signal.aborted).toBe(true)
    pending[1]?.resolve([])
    pending[2]?.resolve([])
    await settle()
  })

  it("unregisters components and rejects ambiguous identities", async () => {
    const refresh = vi.fn(async () => [])
    const registry = new SolidObjectsComponentRegistry<string>({ refresh, apply: () => {} })
    const registration = {
      actorType: "Counter",
      actorId: "one",
      target: "count",
      name: "count",
      observes: ["count"],
    } as const
    const unregister = registry.register(registration)

    expect(() => registry.register(registration)).toThrow("already registered")
    unregister()
    registry.invalidate(invalidation({ observables: { count: 1 } }))
    await settle()

    expect(refresh).not.toHaveBeenCalled()
  })

  it("does not apply a response after its component unregisters", async () => {
    let resolveRefresh: ((results: readonly ComponentRefreshResult<string>[]) => void) | undefined
    const apply = vi.fn()
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: () => new Promise((resolve) => (resolveRefresh = resolve)),
      apply,
    })
    const unregister = registry.register({
      actorType: "Counter",
      actorId: "one",
      target: "count",
      name: "count",
      observes: ["count"],
    })
    registry.invalidate(
      invalidation({
        actorType: "Counter",
        actorId: "one",
        observables: { count: 1 },
      }),
    )
    await settle()

    unregister()
    resolveRefresh?.([{ target: "count", rendered: "stale" }])
    await settle()

    expect(apply).not.toHaveBeenCalled()
  })

  it("validates a complete batch before applying any result", async () => {
    const apply = vi.fn()
    const onError = vi.fn()
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: async () => [
        { target: "player", rendered: "valid" },
        { target: "unexpected", rendered: "invalid" },
      ],
      apply,
      onError,
    })
    registry.register({
      actorType: "GameRoom",
      actorId: "table-1",
      target: "player",
      name: "player",
      observes: ["playerOne"],
      batch: "playmat",
    })

    registry.invalidate(invalidation({ observables: { playerOne: 1 } }))
    await settle()

    expect(apply).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ name: "TypeError" }) }),
    )
  })
})

function invalidation(options: {
  actorType?: string
  actorId?: string
  instanceId?: string
  revision?: string
  observables: Record<string, unknown>
}): InvalidationEnvelope {
  return {
    version: 1,
    kind: "invalidation",
    actorType: options.actorType ?? "GameRoom",
    actorId: options.actorId ?? "table-1",
    instanceId: options.instanceId ?? "instance-1",
    revision: options.revision ?? "1",
    observables: options.observables,
  } as InvalidationEnvelope
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
