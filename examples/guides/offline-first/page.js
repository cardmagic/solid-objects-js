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
