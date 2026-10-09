# Offline-first state in the browser with SQLite WASM

The Solid Objects browser runtime keeps each identity's state in SQLite WASM in the origin private file system (OPFS). Tabs share that state. The runtime queues each write for the server in the same transaction as the local change. The queue sends writes in order when the network returns, and the server applies each write once. The runtime does not replicate server changes to the browser or merge concurrent edits like a CRDT. Nothing runs while the browser is closed.

## The failure: an outbox in page memory

An inspector records findings on a tablet without a network. Each inspection has an identity, and each finding has an ID and a note. The tablet must keep each finding until the server receives it.

```javascript
let pending = []

export function queueFinding(finding) {
  pending = [...pending, finding]
}

export function pendingFindings() {
  return pending.length
}

export async function flushFindings({ send }) {
  while (pending.length > 0) {
    await send(pending[0])
    pending = pending.slice(1)
  }
}
```

This example keeps the outbox in an array in page memory. The `queueFinding` function adds a finding, and `flushFindings` sends each finding before it removes it. A reload or a tab close loses every queued edit. The browser test queues two findings, reloads the page, and finds no queued finding.

A page can close after `flushFindings` sends an edit but before it removes that edit. If the app retries that edit, it sends the edit again. The server needs a key to ignore the repeated edit. A queue must preserve both the edit and its key across attempts.

## The native fix

A durable outbox in IndexedDB preserves queued edits across reloads. The client gives each edit an ID and keeps that ID with the edit. A server table records each ID that the server applies. The server ignores an ID that the table already contains.

With several tabs, one tab at a time must flush the outbox. The Web Locks API can coordinate this work across tabs of the same origin. A tab holds a lock while it sends queued edits. Other tabs wait for the same lock. [MDN describes this use of Web Locks.](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

The Background Synchronization API can retry a send from a service worker after the network returns. It needs a service worker and a secure context. MDN marks it "Limited availability" because it does not work in some widely used browsers. [MDN lists these requirements and limits.](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)

This is a good design when the app needs only a queue. Solid Objects becomes relevant when each identity also has local state, rules, and an order that the server must replay.

## One actor per inspection, in a module worker

```javascript
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
```

The runtime runs in a module worker and imports its APIs from `solid-objects/browser/host`. Each inspection has one `Inspection` actor identity. Its `findings` field holds the local state.

The `sharedSqliteWasm` adapter stores that state in OPFS and shares one database between tabs. One tab holds the database. Other tabs send their SQL to that tab. Another tab takes over when the holder tab closes.

The `record` operation checks the `findingId` before it changes the state. If the finding already exists, the operation returns the count without another change. Otherwise, it adds the finding and calls `this.transmit().record(...)`.

The runtime commits the local change and the write for the server in the same transaction. Thus, a local commit cannot omit its queued write for the server. A retryable failure rolls back the local change and the queued write together.

The `registerTransmit` function gives each queued write to `deliver`. This callback sends the envelope to `/inspections/sync`. The envelope identifies the effect, actor, operation, and arguments. The callback decides whether delivery succeeds or fails.

A network failure throws an `Error`. The effect tries again later with the delay from `retryDelayMilliseconds`. This example increases the delay after each attempt, up to 30 seconds. An HTTP response other than success or 422 also causes an `Error`.

An HTTP 422 response causes `deliver` to throw `NonRetryableError`, from `solid-objects/core`. The runtime moves that effect to dead letters and does not retry it. A normal return marks the write as delivered. The runtime does not inspect the HTTP response itself.

The example sets `maxAttempts` to 1,000 because a long offline period can use many attempts. The default is 5. A high value extends the retry period, but it does not provide unlimited retries.

The short lease settings let another tab take over quickly after a tab closes. The example uses 750 milliseconds for `processAliveThresholdMilliseconds` and `leaseDurationMilliseconds`. It uses 250 milliseconds for `leaseRenewalIntervalMilliseconds`.

The policy permits messages and queries only for the `Inspection` actor type. A browser policy limits what your own page can call. It is not a security boundary because the user controls the page.

```javascript
const worker = new Worker(new URL("./inspection-worker.js", import.meta.url), { type: "module" })
const pending = new Map()
let nextRequestId = 0
let workerFailure

worker.onmessage = (event) => {
  const { requestId, ok, value, message } = event.data
  const request = pending.get(requestId)
  pending.delete(requestId)
  if (ok) {
    request.resolve(value)
    return
  }
  request.reject(new Error(message))
}

worker.onerror = (event) => {
  workerFailure = new Error(`The actor worker failed: ${event.message || "it did not load"}`)
  for (const request of pending.values()) request.reject(workerFailure)
  pending.clear()
}

export function callActor({ actorId, operation, argumentsValue }) {
  if (workerFailure) return Promise.reject(workerFailure)
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, actorId, operation, argumentsValue })
  })
}
```

The page starts a module worker and sends messages through `callActor`. The page holds no actor reference. A request ID connects each response to its call.

If the worker fails to load, the page rejects every call that awaits a response. The page also rejects each later call with the stored error. The map in the page tracks call responses; the database holds the actor state and outbox.

## The server applies each write once

```typescript
import { Actor } from "solid-objects"

type Finding = { findingId: string; note: string }

export class Inspection extends Actor {
  static override readonly actorType = "Inspection"

  findings: Finding[] = []

  record({ findingId, note }: Finding): number {
    if (this.findings.some((finding) => finding.findingId === findingId)) {
      return this.findings.length
    }
    this.findings = [...this.findings, { findingId, note }]
    return this.findings.length
  }
}
```

The server defines an actor with the same actor type, `Inspection`. Its `record` operation adds a finding only if its `findingId` does not already exist. The server operation does not transmit the write again.

```typescript
import {
  IdempotencyConflict,
  InvalidPayload,
  receiveTransmitEnvelope,
  UnknownOperation,
  type SolidObjectsRuntime,
  type TransmitEnvelope,
} from "solid-objects"

export async function handleInspectionSync({
  request,
  runtime,
  canWrite,
}: {
  request: Request
  runtime: SolidObjectsRuntime
  canWrite: (options: { request: Request; envelope: TransmitEnvelope }) => Promise<boolean>
}): Promise<Response> {
  const envelope = (await request.json()) as TransmitEnvelope
  if (!(await canWrite({ request, envelope }))) return new Response("Forbidden", { status: 403 })

  try {
    await receiveTransmitEnvelope({ runtime, envelope })
    return Response.json({})
  } catch (error) {
    if (
      error instanceof InvalidPayload ||
      error instanceof IdempotencyConflict ||
      error instanceof UnknownOperation
    ) {
      return new Response(null, { status: 422 })
    }
    throw error
  }
}
```

The `receiveTransmitEnvelope` function enqueues the write with the effect ID as the idempotency key. This key identifies repeated delivery of the same write. A repeated envelope therefore applies once, even if the browser sends it more than once.

Delivery through `receiveTransmitEnvelope` skips `authorizeMessage`. The route must authenticate the device before it calls this function. It must also check that the device can write the actor in the envelope.

The example gives those checks to `canWrite`. If that callback denies the request, the route answers 403 and does not enqueue the write. The browser policy cannot replace these server checks.

The route answers 422 for `InvalidPayload`, `IdempotencyConflict`, and `UnknownOperation`. An `UnknownOperation` occurs when a device queued a write for an operation that a later server deploy removed. The browser converts that response to `NonRetryableError` and stops retries for that write. This response prevents repeated attempts for an envelope that cannot apply.

A Rails server can receive the same envelopes with `SolidObjects::Transmission.receive`. That method also skips message authorization. Authenticate the device before the call. Check its permission to write the actor.

## Several tabs

Each tab starts its own worker. The workers share the database through `sharedSqliteWasm`. Writes from two tabs to one inspection apply in the local order.

The browser test records two findings in one tab and one finding in a second tab while offline. The server has no findings before the network returns. After the network returns, the server receives all three findings and applies each once, in order.

Run one effect worker for each local runtime to preserve the order of writes for each actor. [The transmit section of the public API](../api.md#solid-objectstransmit) states this requirement. This order belongs to each actor identity; it does not define one order across all inspections.

## What this does not do

- It does not replicate server changes to the browser. Fetch the server state. Alternatively, subscribe with the WebSocket client in `solid-objects/browser`.
- It does not merge concurrent edits from different devices. The server applies writes in the order it receives them for each identity. The application defines the conflict rules. CRDT libraries such as [Yjs](https://yjs.dev) and [Automerge](https://automerge.org) support automatic merges of concurrent edits.
- Nothing runs while the browser is closed. Reminders and the outbox run only while a tab runs the worker. Queued writes wait in OPFS and send when a tab opens again.

## Limits

- CI tests the browser runtime in Chromium only. Safari 16.4 and Firefox 111 added the OPFS API that persistent storage needs. Test each engine that you support.
- Persistent storage needs a secure context and a dedicated worker. An embedded WebView can lack OPFS even when the device browser supports it. Test the WebView itself.
- The browser can clear the storage of an origin. Call `navigator.storage.persist()` to ask the browser to keep it.
- All authorization callbacks deny by default, also in the browser. The example explicitly permits messages and queries for `Inspection`.
- Delivery is at least once. The server must stay idempotent: a repeated write must not cause another state change.

[Step 12 of the agent guide](../agents.md#12-use-the-browser-runtime) explains browser setup and policies. [Correctness and delivery semantics](../correctness.md) defines the guarantees and limits. [Virtual actors in TypeScript and Node.js](../virtual-actors.md) explains the actor model.

## What the tests prove

The [browser tests](../../test/browser/offline-first.browser.ts) check these cases:

- Two tabs record three findings while offline. After the network returns, the server state contains each finding once, in the same order.
- A finding in the local actor state survives a page reload.
- Two findings in the outbox in page memory disappear after a page reload.

The [route tests](../../test/guide-offline-first.test.ts) check these cases:

- A request without device authorization receives 403 and adds no finding.
- An authorized request receives 200 and adds the expected finding.
- A repeated envelope receives 200 and leaves one finding.
- An envelope with an empty operation receives 422.
- An envelope for an operation that the server removed receives 422.

These tests do not check every browser engine or every interruption during delivery. They also do not test `IdempotencyConflict` or the browser response to 422.

## Sources

- MDN, [Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), checked October 9, 2026.
- MDN, [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), checked October 9, 2026.
- [Yjs](https://yjs.dev), and [Automerge](https://automerge.org), checked October 9, 2026.
