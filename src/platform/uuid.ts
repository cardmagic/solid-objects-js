export function randomUUID(): string {
  const platform = globalThis as typeof globalThis & { crypto: { randomUUID(): string } }
  return platform.crypto.randomUUID()
}
