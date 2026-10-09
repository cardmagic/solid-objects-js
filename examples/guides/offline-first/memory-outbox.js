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
