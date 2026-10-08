const worker = new Worker(new URL("./draft-worker.js", import.meta.url), { type: "module" })
const pending = new Map()
let nextRequestId = 0

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

export function callActor({ actorId, operation, argumentsValue }) {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, actorId, operation, argumentsValue })
  })
}
