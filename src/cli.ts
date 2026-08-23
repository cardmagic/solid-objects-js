import "./platform/node.js"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { SolidObjectsRuntime } from "./runtime.js"
import type { RetentionTarget } from "./retention.js"

export interface CliRunOptions {
  signal?: AbortSignal
  write?: (value: string) => void
  loadRuntime?: (path: string) => Promise<SolidObjectsRuntime>
  closeRuntime?: boolean
}

const COMMANDS = new Set([
  "quickstart",
  "start",
  "doctor",
  "status",
  "cleanup",
  "dead-letters",
  "retry-dead-letter",
  "reminders",
  "resume-reminder",
  "prune",
])

const administrationContext = Object.freeze({ source: "cli" })

export async function runCli(
  argumentsValue: readonly string[],
  options: CliRunOptions = {},
): Promise<number> {
  const [command, ...commandArguments] = argumentsValue
  if (!command || command === "help" || command === "--help" || command === "-h") {
    options.write?.(help()) ?? process.stdout.write(help())
    return 0
  }
  if (!COMMANDS.has(command)) throw new TypeError(`unknown command ${JSON.stringify(command)}`)

  const parsed = parseArguments(commandArguments)
  const write = options.write ?? ((value: string) => process.stdout.write(value))
  if (command === "quickstart") {
    assertOptions(parsed, { command, flags: ["json", "yes"] })
    assertNoPositionals(parsed, command)
    const module = (await import(
      new URL("./examples/sqlite-quickstart.js", import.meta.url).href
    )) as {
      runQuickstart(options: {
        signal?: AbortSignal
        write: (value: string) => void
        format: "report" | "json"
        confirm?: () => boolean
      }): Promise<void>
    }
    await module.runQuickstart({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(parsed.flags.has("yes") ? { confirm: () => true } : {}),
      write,
      format: parsed.flags.has("json") ? "json" : "report",
    })
    return 0
  }
  const configurationPath = stringOption(parsed, "config") ?? "solid-objects.config.js"
  const loadRuntime = options.loadRuntime ?? loadRuntimeModule
  const runtime = await loadRuntime(configurationPath)
  await runtime.install()

  try {
    if (command === "start") {
      assertOptions(parsed, { command })
      assertNoPositionals(parsed, command)
      await runtime.run(options.signal ?? new AbortController().signal)
      return 0
    }
    if (command === "doctor") {
      assertOptions(parsed, { command, flags: ["skip-round-trip"] })
      assertNoPositionals(parsed, command)
      const report = await runtime.doctor.run({
        roundTrip: parsed.flags.has("skip-round-trip") ? "skip" : "run",
      })
      writeJson(write, report)
      return report.healthy ? 0 : 1
    }
    if (command === "status") {
      assertOptions(parsed, { command })
      assertNoPositionals(parsed, command)
      writeJson(write, await runtime.processes.all({ authorizationContext: administrationContext }))
      return 0
    }
    if (command === "cleanup") {
      assertOptions(parsed, { command })
      assertNoPositionals(parsed, command)
      writeJson(
        write,
        await runtime.processes.cleanup({ authorizationContext: administrationContext }),
      )
      return 0
    }
    if (command === "dead-letters") {
      assertOptions(parsed, { command })
      assertNoPositionals(parsed, command)
      writeJson(
        write,
        await runtime.deadLetters.all({ authorizationContext: administrationContext }),
      )
      return 0
    }
    if (command === "retry-dead-letter") {
      assertOptions(parsed, { command })
      const id = requiredPositional(parsed, command)
      const message = await runtime.deadLetters.retry(id, {
        authorizationContext: administrationContext,
      })
      writeJson(write, { messageId: message.id, requestId: message.requestId })
      return 0
    }
    if (command === "reminders") {
      assertOptions(parsed, { command, options: ["actor-type", "status"] })
      assertNoPositionals(parsed, command)
      const actorType = stringOption(parsed, "actor-type")
      const status = stringOption(parsed, "status")
      const page = await runtime.reminders.all({
        authorizationContext: administrationContext,
        ...(actorType === undefined ? {} : { actorType }),
        ...(status === undefined ? {} : { status: reminderStatus(status) }),
      })
      writeJson(write, page)
      return 0
    }
    if (command === "resume-reminder") {
      assertOptions(parsed, { command, options: ["run-at"] })
      const id = requiredPositional(parsed, command)
      const runAt = stringOption(parsed, "run-at")
      const reminder = await runtime.reminders.resume(id, {
        authorizationContext: administrationContext,
        ...(runAt === undefined ? {} : { runAt: dateOption(runAt, "run-at") }),
      })
      writeJson(write, reminder)
      return 0
    }

    assertOptions(parsed, { command, flags: ["execute"] })
    const target = retentionTarget(requiredPositional(parsed, command))
    const result = parsed.flags.has("execute")
      ? await runtime.retention.prune({
          target,
          authorizationContext: administrationContext,
        })
      : await runtime.retention.preview({
          target,
          authorizationContext: administrationContext,
        })
    writeJson(write, {
      target: result.target,
      mode: parsed.flags.has("execute") ? "execute" : "preview",
      count: result.count,
    })
    return 0
  } finally {
    if (options.closeRuntime !== false) await runtime.close()
  }
}

interface ParsedArguments {
  readonly positionals: string[]
  readonly flags: Set<string>
  readonly options: Map<string, string>
}

function parseArguments(argumentsValue: readonly string[]): ParsedArguments {
  const positionals: string[] = []
  const flags = new Set<string>()
  const options = new Map<string, string>()
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index]
    if (!argument) continue
    if (!argument.startsWith("--") && argument !== "-c") {
      positionals.push(argument)
      continue
    }
    const name = argument === "-c" ? "config" : argument.slice(2)
    if (name === "execute" || name === "skip-round-trip" || name === "json" || name === "yes") {
      flags.add(name)
      continue
    }
    const value = argumentsValue[index + 1]
    if (!value || value.startsWith("-")) throw new TypeError(`--${name} requires a value`)
    options.set(name, value)
    index += 1
  }
  return { positionals, flags, options }
}

async function loadRuntimeModule(path: string): Promise<SolidObjectsRuntime> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>
  let runtime = module.default ?? module.runtime
  if (typeof runtime === "function") runtime = await runtime()
  if (!(runtime instanceof SolidObjectsRuntime)) {
    throw new TypeError(`${path} must export a SolidObjectsRuntime as default or runtime`)
  }
  return runtime
}

function stringOption(argumentsValue: ParsedArguments, name: string): string | undefined {
  return argumentsValue.options.get(name)
}

function requiredPositional(argumentsValue: ParsedArguments, command: string): string {
  const [value, ...extra] = argumentsValue.positionals
  if (!value || extra.length > 0) throw new TypeError(`${command} requires exactly one argument`)
  return value
}

function assertNoPositionals(argumentsValue: ParsedArguments, command: string): void {
  if (argumentsValue.positionals.length > 0) {
    throw new TypeError(`${command} does not accept positional arguments`)
  }
}

function assertOptions(
  argumentsValue: ParsedArguments,
  allowed: { command: string; options?: readonly string[]; flags?: readonly string[] },
): void {
  const optionNames = new Set(["config", ...(allowed.options ?? [])])
  const flagNames = new Set(allowed.flags ?? [])
  const unknownOption = [...argumentsValue.options.keys()].find((name) => !optionNames.has(name))
  if (unknownOption) throw new TypeError(`${allowed.command} does not accept --${unknownOption}`)
  const unknownFlag = [...argumentsValue.flags].find((name) => !flagNames.has(name))
  if (unknownFlag) throw new TypeError(`${allowed.command} does not accept --${unknownFlag}`)
}

function retentionTarget(value: string): RetentionTarget {
  if (value === "messages" || value === "instances" || value === "processes") return value
  throw new TypeError(`unknown retention target ${JSON.stringify(value)}`)
}

function reminderStatus(value: string): "scheduled" | "paused" | "completed" {
  if (value === "scheduled" || value === "paused" || value === "completed") return value
  throw new TypeError(`unknown reminder status ${JSON.stringify(value)}`)
}

function dateOption(value: string, name: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`--${name} must be an ISO date`)
  return date
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(
    `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item), 2)}\n`,
  )
}

function help(): string {
  return `Usage: solid-objects <command> [options]

Commands:
  quickstart [--json] [--yes]
  start
  doctor [--skip-round-trip]
  status
  cleanup
  dead-letters
  retry-dead-letter ID
  reminders [--actor-type TYPE] [--status STATUS]
  resume-reminder ID [--run-at ISO_DATE]
  prune messages|instances|processes [--execute]

Options:
  --config, -c PATH  Application module (default: solid-objects.config.js)
`
}
