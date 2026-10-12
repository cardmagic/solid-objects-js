export async function processMessages(worker: {
  runUntilIdle(): Promise<number>
}): Promise<number> {
  let processed = 0
  for (let attempt = 0; attempt < 200 && processed === 0; attempt += 1) {
    processed = await worker.runUntilIdle()
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return processed
}
