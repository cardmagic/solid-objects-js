import { Actor, configure, sharedSqliteWasm } from "solid-objects/browser/host"

class NoteDraft extends Actor {
  static actorType = "NoteDraft"

  text = ""
  revision = 0

  edit({ text }) {
    this.text = text
    this.revision += 1
    return this.revision
  }
}

const allowNoteDrafts = ({ actorType }) => actorType === "NoteDraft"

const runtime = configure({
  database: sharedSqliteWasm({ path: "notes.db" }),
  authorizeMessage: allowNoteDrafts,
  authorizeQuery: allowNoteDrafts,
  processAliveThresholdMilliseconds: 750,
  leaseDurationMilliseconds: 750,
  leaseRenewalIntervalMilliseconds: 250,
})
runtime.register(NoteDraft)
const installed = runtime.install()
installed.then(() => runtime.run(new AbortController().signal))

self.onmessage = async (event) => {
  const { requestId, actorId, operation, argumentsValue } = event.data
  try {
    await installed
    const value = await NoteDraft.ref(actorId)[operation](argumentsValue)
    postMessage({ requestId, ok: true, value })
  } catch (error) {
    postMessage({ requestId, ok: false, message: String(error?.message ?? error) })
  }
}
