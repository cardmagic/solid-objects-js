import { afterEach, describe, expect, it } from "vitest"
import { sqlite } from "../src/database/sqlite.js"
import { runCli } from "../src/cli.js"
import { configureSolidObjects, type SolidObjectsRuntime } from "../src/runtime.js"

let runtime: SolidObjectsRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  runtime = undefined
})

describe("command line interface", () => {
  it("loads the default runtime export from a config module", async () => {
    const output: string[] = []

    const exitCode = await runCli(
      ["doctor", "--skip-round-trip", "--config", "test/fixtures/cli-config.ts"],
      { write: (value) => output.push(value) },
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.join(""))).toMatchObject({ healthy: true })
  })

  it("runs doctor through an application runtime module", async () => {
    const output: string[] = []
    runtime = configuredRuntime()

    const exitCode = await runCli(["doctor", "--skip-round-trip"], {
      loadRuntime: async () => runtime!,
      write: (value) => output.push(value),
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.join(""))).toMatchObject({ healthy: true })
  })

  it("inspects and cleans up processes with the CLI authorization context", async () => {
    const contexts: unknown[] = []
    runtime = configuredRuntime({
      authorizeAdministration: ({ authorizationContext }) => {
        contexts.push(authorizationContext)
        return true
      },
    })
    await runtime.install()
    await runtime.repository.registerProcess("stale", "worker")
    await runtime.settings.database.connection((connection) =>
      connection.run(`UPDATE ${runtime?.repository.table("processes")} SET heartbeat_at_ms = 0`),
    )
    const statusOutput: string[] = []

    expect(
      await runCli(["status"], {
        loadRuntime: async () => runtime!,
        write: (value) => statusOutput.push(value),
        closeRuntime: false,
      }),
    ).toBe(0)
    expect(JSON.parse(statusOutput.join(""))[0]).toMatchObject({ id: "stale", stale: true })

    const cleanupOutput: string[] = []
    expect(
      await runCli(["cleanup"], {
        loadRuntime: async () => runtime!,
        write: (value) => cleanupOutput.push(value),
        closeRuntime: false,
      }),
    ).toBe(0)
    expect(JSON.parse(cleanupOutput.join(""))).toEqual({ cleaned: 1 })
    expect(contexts).toEqual([{ source: "cli" }, { source: "cli" }])
  })

  it("previews retention unless execute is explicit", async () => {
    runtime = configuredRuntime()
    const output: string[] = []

    await runCli(["prune", "messages"], {
      loadRuntime: async () => runtime!,
      write: (value) => output.push(value),
    })

    expect(JSON.parse(output.join(""))).toEqual({ target: "messages", mode: "preview", count: 0 })
  })

  it("rejects unknown commands before loading application code", async () => {
    let loaded = false

    await expect(
      runCli(["unknown"], {
        loadRuntime: async () => {
          loaded = true
          return configuredRuntime()
        },
        write: () => {},
      }),
    ).rejects.toThrow("unknown command")
    expect(loaded).toBe(false)
  })

  it("rejects options that do not belong to a command", async () => {
    runtime = configuredRuntime()

    await expect(
      runCli(["status", "--execute"], {
        loadRuntime: async () => runtime!,
        write: () => {},
      }),
    ).rejects.toThrow("status does not accept --execute")
  })
})

function configuredRuntime(
  overrides: {
    authorizeAdministration?: (input: { authorizationContext: unknown }) => boolean
  } = {},
): SolidObjectsRuntime {
  runtime = configureSolidObjects({
    database: sqlite({ path: ":memory:" }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeAdministration: () => true,
    ...overrides,
  })
  return runtime
}
