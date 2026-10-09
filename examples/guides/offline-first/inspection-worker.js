import { NonRetryableError } from "solid-objects/core"
import { Actor, configure, registerTransmit, sharedSqliteWasm } from "solid-objects/browser/host"

class Inspection extends Actor {
  static actorType = "Inspection"

  findings = []

  record({ findingId, note }) {
    if (this.findings.some((finding) => finding.findingId === findingId)) {
      return this.findings.length
    }
    this.findings = [...this.findings, { findingId, note }]
    this.transmit().record({ findingId, note })
    return this.findings.length
  }
}

const allowInspections = ({ actorType }) => actorType === "Inspection"

const runtime = configure({
  database: sharedSqliteWasm({ path: "inspections.db" }),
  authorizeMessage: allowInspections,
  authorizeQuery: allowInspections,
  maxAttempts: 1_000,
  retryDelayMilliseconds: (attempt) => Math.min(2 ** (attempt - 1), 30) * 1_000,
  processAliveThresholdMilliseconds: 750,
  leaseDurationMilliseconds: 750,
  leaseRenewalIntervalMilliseconds: 250,
})

registerTransmit({
  runtime,
  deliver: async (envelope) => {
    const response = await fetch("/inspections/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    })
    if (response.status === 422) {
      throw new NonRetryableError(`The server rejected effect ${envelope.effectId}`)
    }
    if (!response.ok) throw new Error(`Sync failed with HTTP ${response.status}`)
  },
})
runtime.register(Inspection)
const installed = runtime.install()
installed.then(() => runtime.run(new AbortController().signal))

self.onmessage = async (event) => {
  const { requestId, actorId, operation, argumentsValue } = event.data
  try {
    await installed
    const value = await Inspection.ref(actorId)[operation](argumentsValue)
    postMessage({ requestId, ok: true, value })
  } catch (error) {
    postMessage({ requestId, ok: false, message: String(error?.message ?? error) })
  }
}
