import { afterEach, describe, expect, it } from "vitest"
import { Actor } from "../src/actor.js"
import { sqlite } from "../src/database/sqlite.js"
import { Unauthorized } from "../src/errors.js"
import { configure, type SolidObjectsRuntime } from "../src/runtime.js"
import { TRANSMIT_EFFECT } from "../src/transmit-effect.js"

class OrderActor extends Actor {
  static override readonly actorType = "RedriveOrderActor"

  count = 0
  orders = 0

  place(): void {
    this.orders += 1
    this.emit("settle", { arguments: { order: "one" } })
  }

  touch(): void {
    this.count += 1
  }

  sendElsewhere(): void {
    this.transmit().touch()
  }

  override observables(): { count: number } {
    return { count: this.count }
  }
}

class PoisonActor extends Actor {
  static override readonly actorType = "RedrivePoisonActor"
  static fail = true

  run(): void {
    if (PoisonActor.fail) throw new Error("poison message")
  }
}

let runtime: SolidObjectsRuntime | undefined
type SettleArguments = { order?: string; operation?: string }

let settle: (argumentsValue: SettleArguments) => void = () => {}
let deliver: () => void = () => {}

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  PoisonActor.fail = true
  settle = () => {}
  deliver = () => {}
})

async function start(): Promise<SolidObjectsRuntime> {
  const created = configure({
    database: sqlite({ path: ":memory:" }),
    maxAttempts: 1,
    retryDelayMilliseconds: () => 0,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeAdministration: () => true,
    broadcast: async () => deliver(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })
  created.registerEffect("settle", (argumentsValue) => settle(argumentsValue))
  created.registerEffect(TRANSMIT_EFFECT, (argumentsValue) => settle(argumentsValue))
  created.register(OrderActor)
  created.register(PoisonActor)
  await created.install()
  runtime = created
  return created
}

async function deadEffect(active: SolidObjectsRuntime): Promise<string> {
  settle = () => {
    throw new Error("settlement declined")
  }
  await active.ref(OrderActor, "one").send.place()
  await active.worker().runUntilIdle()
  await active.effectWorker().runUntilIdle()
  const dead = await active.deadLetters.effects.all()
  expect(dead).toHaveLength(1)
  return dead[0]!.id
}

async function deadBroadcast(active: SolidObjectsRuntime): Promise<string> {
  deliver = () => {
    throw new Error("transport down")
  }
  await active.ref(OrderActor, "broadcast").send.touch()
  await active.worker().runUntilIdle()
  await active.broadcastWorker().runUntilIdle()
  const dead = await active.deadLetters.broadcasts.all()
  expect(dead).toHaveLength(1)
  return dead[0]!.id
}

describe("dead-letter scopes", () => {
  it("returns a dead effect to pending and runs it again", async () => {
    const active = await start()
    const id = await deadEffect(active)
    const settled: SettleArguments[] = []

    await active.deadLetters.effects.retry(id)

    expect(await active.deadLetters.effects.all()).toHaveLength(0)
    settle = (argumentsValue) => {
      settled.push(argumentsValue)
    }
    await active.effectWorker().runUntilIdle()

    expect(settled).toEqual([{ order: "one" }])
  })

  it("reuses the stable effect id when it retries", async () => {
    const active = await start()
    const id = await deadEffect(active)

    const retried = await active.deadLetters.effects.retry(id)

    expect(retried.id).toBe(id)
  })

  it("leaves an effect that is already pending alone", async () => {
    const active = await start()
    const id = await deadEffect(active)
    const first = await active.deadLetters.effects.retry(id)

    const second = await active.deadLetters.effects.retry(id)

    expect(second.status).toBe("pending")
    expect(second.availableAt).toEqual(first.availableAt)
  })

  it("returns a dead broadcast to pending and delivers it", async () => {
    const active = await start()
    const id = await deadBroadcast(active)

    await active.deadLetters.broadcasts.retry(id)

    expect(await active.deadLetters.broadcasts.all()).toHaveLength(0)
    deliver = () => {}
    await active.broadcastWorker().runUntilIdle()
    expect(await active.deadLetters.broadcasts.all()).toHaveLength(0)
  })

  it("replays a dead transmit effect", async () => {
    const active = await start()
    const transmitted: SettleArguments[] = []
    settle = () => {
      throw new Error("carrier down")
    }
    await active.ref(OrderActor, "one").send.sendElsewhere()
    await active.worker().runUntilIdle()
    await active.effectWorker().runUntilIdle()
    const dead = await active.deadLetters.effects.all()
    expect(dead).toHaveLength(1)

    settle = (argumentsValue) => {
      transmitted.push(argumentsValue)
    }
    await active.deadLetters.effects.retry(dead[0]!.id)
    await active.effectWorker().runUntilIdle()

    expect(await active.deadLetters.effects.all()).toHaveLength(0)
    expect(transmitted.map(({ operation }) => operation)).toEqual(["touch"])
  })

  it("reads only dead rows, not pending ones", async () => {
    const active = await start()
    const id = await deadEffect(active)
    settle = () => {}
    await active.ref(OrderActor, "two").send.place()
    await active.worker().runUntilIdle()

    expect((await active.deadLetters.effects.all()).map((row) => row.id)).toEqual([id])
  })

  it("reads and retries message dead letters as it always has", async () => {
    const active = await start()
    await active.ref(PoisonActor, "one").send.run()
    await active.worker().runUntilIdle()
    const letters = await active.deadLetters.all()
    PoisonActor.fail = false

    const reference = await active.deadLetters.retry(letters[0]!.id)
    await active.worker().runUntilIdle()

    expect(letters).toHaveLength(1)
    expect(await reference.status()).toBe("completed")
  })

  it("reads only its own kind", async () => {
    const active = await start()
    const effectId = await deadEffect(active)
    const broadcastId = await deadBroadcast(active)
    await active.ref(PoisonActor, "one").send.run()
    await active.worker().runUntilIdle()

    expect((await active.deadLetters.effects.all()).map(({ id }) => id)).toEqual([effectId])
    expect((await active.deadLetters.broadcasts.all()).map(({ id }) => id)).toEqual([broadcastId])
    expect(await active.deadLetters.all()).toHaveLength(1)
  })

  it("refuses an unauthorized caller", async () => {
    const active = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
    })
    runtime = active
    await active.install()

    await expect(active.deadLetters.effects.all()).rejects.toBeInstanceOf(Unauthorized)
    await expect(active.deadLetters.effects.retry("missing")).rejects.toBeInstanceOf(Unauthorized)
    await expect(active.deadLetters.broadcasts.retry("missing")).rejects.toBeInstanceOf(
      Unauthorized,
    )
  })

  it("names the scope it authorizes", async () => {
    const seen: { action: string; resource: string }[] = []
    const active = configure({
      database: sqlite({ path: ":memory:" }),
      authorizeMessage: () => true,
      authorizeAdministration: ({ action, resource }) => {
        seen.push({ action, resource })
        return true
      },
    })
    runtime = active
    await active.install()

    await active.deadLetters.effects.all()

    expect(seen).toEqual([{ action: "inspect", resource: "effect_dead_letters" }])
  })
})
