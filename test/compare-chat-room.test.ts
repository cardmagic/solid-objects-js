import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Unauthorized } from "../src/errors.js"
import type { SolidObjectsRuntime } from "../src/runtime.js"
import { ARCHIVE_AFTER_MILLISECONDS, ChatRoom } from "../examples/compare/chat-room.js"
import { chatRuntime } from "../examples/compare/chat-runtime.js"

let directory: string
const runtimes: SolidObjectsRuntime[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "compare-chat-"))
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

async function startRuntime(): Promise<SolidObjectsRuntime> {
  const runtime = chatRuntime({ path: join(directory, "chat.sqlite3") })
  runtimes.push(runtime)
  await runtime.install()
  return runtime
}

async function stopRuntime(runtime: SolidObjectsRuntime): Promise<void> {
  await runtime.close()
  runtimes.splice(runtimes.indexOf(runtime), 1)
}

function asMember(memberId: string): { authorizationContext: { memberId: string } } {
  return { authorizationContext: { memberId } }
}

async function roomWithMembers(runtime: SolidObjectsRuntime): Promise<void> {
  await runtime.ref(ChatRoom, "general").with(asMember("ada")).join({ memberId: "ada" })
  await runtime.ref(ChatRoom, "general").with(asMember("grace")).join({ memberId: "grace" })
}

describe("the ChatRoom actor", () => {
  it("gives messages that arrive at the same time one order with no gaps", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)
    const authors = ["ada", "grace"]

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const authorId = authors[index % 2] ?? "ada"
        return runtime
          .ref(ChatRoom, "general")
          .with(asMember(authorId))
          .post({ authorId, text: `message ${index}` })
      }),
    )

    expect(results.map((result) => result.sequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
    const snapshot = await runtime.ref(ChatRoom, "general").snapshot(asMember("ada"))
    expect(snapshot.messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
  })

  it("counts unread messages for each member", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)
    const ada = runtime.ref(ChatRoom, "general").with(asMember("ada"))
    await ada.post({ authorId: "ada", text: "one" })
    await ada.post({ authorId: "ada", text: "two" })
    await ada.post({ authorId: "ada", text: "three" })

    await runtime
      .ref(ChatRoom, "general")
      .with(asMember("grace"))
      .markRead({ memberId: "grace", sequence: 2 })

    expect(await runtime.ref(ChatRoom, "general").with(asMember("grace")).unreadCounts).toEqual({
      ada: 0,
      grace: 1,
    })
  })

  it("keeps the pinned message and archives the room after seven idle days and a restart", async () => {
    const beforeRestart = await startRuntime()
    await roomWithMembers(beforeRestart)
    const ada = beforeRestart.ref(ChatRoom, "general").with(asMember("ada"))
    const { sequence } = await ada.post({ authorId: "ada", text: "Read the rules" })
    await ada.pin({ memberId: "ada", sequence })
    await stopRuntime(beforeRestart)

    const afterRestart = await startRuntime()
    await afterRestart.testing.runDueReminders({
      now: new Date(Date.now() + ARCHIVE_AFTER_MILLISECONDS + 1_000),
    })
    await afterRestart.testing.drain({ roles: ["actors"] })

    const snapshot = await afterRestart.ref(ChatRoom, "general").snapshot(asMember("ada"))
    expect(snapshot).toMatchObject({ archived: true, pinned: { sequence, text: "Read the rules" } })
    await expect(
      afterRestart
        .ref(ChatRoom, "general")
        .with(asMember("ada"))
        .post({ authorId: "ada", text: "Anyone here?" }),
    ).rejects.toMatchObject({ code: "archived" })
  })

  it("refuses a post in the name of another member", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)

    await expect(
      runtime
        .ref(ChatRoom, "general")
        .with(asMember("grace"))
        .post({ authorId: "ada", text: "Not mine" }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })

  it("refuses a caller with no credentials, even with a null member ID", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)
    const anonymous = runtime.ref(ChatRoom, "general").with({ authorizationContext: undefined })

    await expect(anonymous.join({ memberId: null as unknown as string })).rejects.toBeInstanceOf(
      Unauthorized,
    )
    await expect(
      anonymous.post({ authorId: null as unknown as string, text: "Hello" }),
    ).rejects.toBeInstanceOf(Unauthorized)
  })

  it("keeps the text of a pinned message after newer messages push it out", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)
    const ada = runtime.ref(ChatRoom, "general").with(asMember("ada"))
    const { sequence } = await ada.post({ authorId: "ada", text: "Read the rules" })
    await ada.pin({ memberId: "ada", sequence })
    for (let index = 0; index < 200; index += 1) {
      await ada.post({ authorId: "ada", text: `message ${index}` })
    }

    const snapshot = await runtime.ref(ChatRoom, "general").snapshot(asMember("ada"))
    expect(snapshot.messages.some((message) => message.sequence === sequence)).toBe(false)
    expect(snapshot.pinned).toEqual({ sequence, authorId: "ada", text: "Read the rules" })
  }, 30_000)

  it("ignores an archive reminder that was queued behind newer activity", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)
    await runtime
      .ref(ChatRoom, "general")
      .send.with({ ...asMember("ada"), idempotencyKey: "late-post" })
      .post({ authorId: "ada", text: "Still here" })

    await runtime.testing.runDueReminders({
      now: new Date(Date.now() + ARCHIVE_AFTER_MILLISECONDS + 1_000),
    })
    await runtime.testing.drain({ roles: ["actors"] })

    const snapshot = await runtime.ref(ChatRoom, "general").snapshot(asMember("ada"))
    expect(snapshot.archived).toBe(false)
    expect(snapshot.messages.map((message) => message.text)).toEqual(["Still here"])
  })

  it("refuses a post from someone who did not join", async () => {
    const runtime = await startRuntime()
    await roomWithMembers(runtime)

    await expect(
      runtime
        .ref(ChatRoom, "general")
        .with(asMember("mallory"))
        .post({ authorId: "mallory", text: "Hello" }),
    ).rejects.toMatchObject({ code: "not_a_member" })
  })
})
