import { afterEach, describe, expect, it } from "vitest"
import "../src/platform/node.js"
import { Actor } from "../src/actor.js"
import { createRuntime, type SolidObjectsRuntime } from "../src/runtime.js"
import { sqlite } from "../src/database/sqlite.js"
import {
  connectTabClient,
  startTabHost,
  type TabClient,
  type TabHost,
} from "../src/browser/tab-host.js"

class TabCounter extends Actor {
  static override readonly actorType = "TabCounter"

  count = 0

  increment({ amount = 1 }: { amount?: number } = {}): number {
    this.count += amount
    return this.count
  }
}

const hosts: TabHost[] = []
const clients: TabClient[] = []

afterEach(async () => {
  for (const client of clients) client.close()
  await Promise.all(hosts.map((host) => host.close()))
  hosts.length = 0
  clients.length = 0
})

function trackedHost(name: string): TabHost {
  const host = startTabHost({
    name,
    startRuntime: async () => {
      const runtime: SolidObjectsRuntime = createRuntime({
        database: sqlite({ path: ":memory:" }),
        authorizeMessage: () => true,
        authorizeQuery: () => true,
        authorizeDestroy: () => true,
        pollingIntervalMilliseconds: 1,
        syncPollingIntervalMilliseconds: 1,
      })
      runtime.register(TabCounter)
      await runtime.install()
      return { runtime }
    },
  })
  hosts.push(host)
  return host
}

function trackedClient(name: string): TabClient {
  const client = connectTabClient({
    name,
    retryIntervalMilliseconds: 50,
    timeoutMilliseconds: 10_000,
  })
  clients.push(client)
  return client
}

const describeTabHost = globalThis.navigator?.locks ? describe : describe.skip

describeTabHost("tab host", () => {
  it("elects one leader and serves invocations from any participant", async () => {
    const name = `election-${crypto.randomUUID()}`
    const first = trackedHost(name)
    await first.leadership()
    const second = trackedHost(name)
    const client = trackedClient(name)

    const initial = await client.invoke({
      actorType: "TabCounter",
      actorId: "shared",
      operation: "increment",
      arguments: { amount: 2 },
    })
    const next = await client.invoke({
      actorType: "TabCounter",
      actorId: "shared",
      operation: "increment",
    })

    expect(initial).toBe(2)
    expect(next).toBe(3)
    expect(first.role()).toBe("leader")
    expect(second.role()).toBe("follower")
  })

  it("fails over to the next host when the leader closes", async () => {
    const name = `failover-${crypto.randomUUID()}`
    const first = trackedHost(name)
    await first.leadership()
    const second = trackedHost(name)
    const client = trackedClient(name)

    expect(
      await client.invoke({ actorType: "TabCounter", actorId: "solo", operation: "increment" }),
    ).toBe(1)

    const closing = first.close()
    const served = client.invoke({
      actorType: "TabCounter",
      actorId: "solo",
      operation: "increment",
    })
    await closing
    await second.leadership()

    expect(await served).toBe(1)
    expect(second.role()).toBe("leader")
  })

  it("reports an invocation error from the leader", async () => {
    const name = `errors-${crypto.randomUUID()}`
    const host = trackedHost(name)
    await host.leadership()
    const client = trackedClient(name)

    await expect(
      client.invoke({ actorType: "TabCounter", actorId: "solo", operation: "missing" }),
    ).rejects.toThrow(/missing/)
  })

  it("times out when no host exists", async () => {
    const name = `nobody-${crypto.randomUUID()}`
    const client = connectTabClient({
      name,
      retryIntervalMilliseconds: 20,
      timeoutMilliseconds: 100,
    })
    clients.push(client)

    await expect(
      client.invoke({ actorType: "TabCounter", actorId: "solo", operation: "increment" }),
    ).rejects.toThrow(/no tab host answered/)
  })
})
