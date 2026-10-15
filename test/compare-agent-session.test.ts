import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Unauthorized } from "../src/errors.js"
import type { SolidObjectsRuntime } from "../src/runtime.js"
import { agentRuntime, type ModelClient } from "../examples/compare/agent-runtime.js"
import {
  AgentSession,
  FOLLOW_UP_MILLISECONDS,
  type Entry,
} from "../examples/compare/agent-session.js"

let directory: string
const runtimes: SolidObjectsRuntime[] = []

class FakeModel implements ModelClient {
  readonly idempotencyKeys: string[] = []
  failNextCall = false

  async reply({
    idempotencyKey,
    history,
  }: {
    idempotencyKey: string
    history: Entry[]
  }): Promise<{ content: string }> {
    this.idempotencyKeys.push(idempotencyKey)
    if (this.failNextCall) {
      this.failNextCall = false
      throw new Error("the model call timed out")
    }
    return { content: `answer to ${history.at(-1)?.content ?? "nothing"}` }
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "compare-agent-"))
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

async function startRuntime(model: ModelClient): Promise<SolidObjectsRuntime> {
  const runtime = agentRuntime({
    path: join(directory, "agents.sqlite3"),
    model,
    retryDelayMilliseconds: () => 0,
  })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

async function stopRuntime(runtime: SolidObjectsRuntime): Promise<void> {
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
}

const asAda = { authorizationContext: { userId: "ada" } }

describe("the AgentSession actor", () => {
  it("applies user messages and tool results in the order they were sent", async () => {
    const runtime = await startRuntime(new FakeModel())
    const session = runtime.ref(AgentSession, "ada")

    await session.send.with({ ...asAda, idempotencyKey: "m1" }).receive({
      role: "user",
      content: "Where is order 42?",
    })
    await session.send.with({ ...asAda, idempotencyKey: "m2" }).receive({
      role: "tool",
      content: "order 42: packed",
    })
    await session.send.with({ ...asAda, idempotencyKey: "m3" }).receive({
      role: "user",
      content: "Tell me when it ships",
    })
    await runtime.testing.drain({ roles: ["actors"] })

    const snapshot = await session.snapshot(asAda)
    expect(snapshot.history.map((entry) => entry.content)).toEqual([
      "Where is order 42?",
      "order 42: packed",
      "Tell me when it ships",
    ])
    expect(snapshot.turn).toBe(3)
  })

  it("sends a retried model call with the same idempotency key", async () => {
    const model = new FakeModel()
    const runtime = await startRuntime(model)
    const session = runtime.ref(AgentSession, "ada").with(asAda)
    model.failNextCall = true

    await session.receive({ role: "user", content: "Hello" })
    await runtime.testing.drain({ roles: ["effects", "actors"] })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    expect(model.idempotencyKeys).toHaveLength(2)
    expect(new Set(model.idempotencyKeys).size).toBe(1)
    const snapshot = await runtime.ref(AgentSession, "ada").snapshot(asAda)
    expect(snapshot.history.at(-1)).toEqual({ role: "assistant", content: "answer to Hello" })
    expect(snapshot.history.filter((entry) => entry.role === "assistant")).toHaveLength(1)
  })

  it("keeps only the reply for the newest turn", async () => {
    const runtime = await startRuntime(new FakeModel())
    const session = runtime.ref(AgentSession, "ada").with(asAda)

    await session.receive({ role: "user", content: "First" })
    await session.receive({ role: "user", content: "Second" })
    await runtime.testing.drain({ roles: ["effects", "actors"] })

    const snapshot = await runtime.ref(AgentSession, "ada").snapshot(asAda)
    expect(snapshot.history.filter((entry) => entry.role === "assistant")).toEqual([
      { role: "assistant", content: "answer to Second" },
    ])
  })

  it("runs a follow-up after a restart", async () => {
    const beforeRestart = await startRuntime(new FakeModel())
    await beforeRestart
      .ref(AgentSession, "ada")
      .with(asAda)
      .followUpLater({ topic: "order 42 shipped?" })
    await stopRuntime(beforeRestart)

    const afterRestart = await startRuntime(new FakeModel())
    await afterRestart.testing.runDueReminders({
      now: new Date(Date.now() + FOLLOW_UP_MILLISECONDS + 1_000),
    })
    await afterRestart.testing.drain({ roles: ["actors"] })

    const snapshot = await afterRestart.ref(AgentSession, "ada").snapshot(asAda)
    expect(snapshot.followUps).toEqual(["order 42 shipped?"])
    expect(snapshot.history.at(-1)).toEqual({
      role: "tool",
      content: "Follow-up due: order 42 shipped?",
    })
  })

  it("refuses a caller who does not own the session", async () => {
    const runtime = await startRuntime(new FakeModel())

    await expect(
      runtime
        .ref(AgentSession, "ada")
        .with({ authorizationContext: { userId: "mallory" } })
        .receive({ role: "user", content: "Hi" }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })
})
