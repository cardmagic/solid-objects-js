export function randomUUID(): string {
  const platform = globalThis as typeof globalThis & { crypto: { randomUUID(): string } }
  return platform.crypto.randomUUID()
}

export async function sha256Hex(value: string): Promise<string> {
  const platform = globalThis as typeof globalThis & {
    crypto: { subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> } }
  }
  const digest = await platform.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
