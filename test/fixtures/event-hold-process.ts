import { eventRuntime } from "../../examples/guides/race-conditions/event-runtime.js"
import { EventSeats } from "../../examples/guides/race-conditions/event-seats.js"

type Instructions = { path: string; eventId: string; holdIds: string[] }

const buyer = { userId: "child-buyer", role: "buyer" as const }

process.once("message", async (instructions: Instructions) => {
  const runtime = eventRuntime({ path: instructions.path })
  await runtime.install()
  process.send?.({ event: "ready" })
  process.once("message", async () => {
    const results = await Promise.all(
      instructions.holdIds.map((holdId) =>
        runtime
          .ref(EventSeats, instructions.eventId)
          .with({ authorizationContext: buyer })
          .hold({ holdId, buyer: holdId }),
      ),
    )
    await runtime.close()
    process.send?.({ event: "done", results })
  })
})
