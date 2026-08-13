import type { SolidObjectsRuntime } from "./runtime.js"
import type { LongRunningComponent } from "./types.js"
import { broadcastsEnabled } from "./configuration.js"

export type TestHelperRole = "actors" | "effects" | "reminders" | "broadcasts"

export interface TestDrainOptions {
  roles?: readonly TestHelperRole[]
  maxPasses?: number
}

interface TestRunner extends LongRunningComponent {
  runOnce(): Promise<number>
}

export class SolidObjectsTestHelper {
  constructor(private readonly runtime: SolidObjectsRuntime) {}

  async drain(options: TestDrainOptions = {}): Promise<number> {
    const roles = options.roles ?? this.defaultRoles()
    const maxPasses = options.maxPasses ?? 1_000
    if (!Number.isSafeInteger(maxPasses) || maxPasses < 1) {
      throw new TypeError("maxPasses must be a positive safe integer")
    }
    for (const role of roles) assertRole(role)
    const runners = this.buildRunners(roles)
    const sequence = [
      runners.get("reminders"),
      runners.get("actors"),
      runners.get("effects"),
      runners.get("actors"),
      runners.get("broadcasts"),
    ].filter((runner): runner is TestRunner => runner !== undefined)
    let total = 0
    try {
      for (let pass = 0; pass < maxPasses; pass += 1) {
        let processed = 0
        for (const runner of sequence) processed += await runner.runOnce()
        if (processed === 0) return total
        total += processed
      }
      return total
    } finally {
      await Promise.allSettled([...new Set(sequence)].map((runner) => runner.stop()))
    }
  }

  reset(): Promise<void> {
    return this.runtime.resetForTesting()
  }

  private defaultRoles(): readonly TestHelperRole[] {
    const roles: TestHelperRole[] = ["reminders", "actors", "effects"]
    if (broadcastsEnabled(this.runtime.settings)) roles.push("broadcasts")
    return roles
  }

  private buildRunners(roles: readonly TestHelperRole[]): Map<TestHelperRole, TestRunner> {
    const runners = new Map<TestHelperRole, TestRunner>()
    for (const role of new Set(roles)) {
      if (role === "actors") runners.set(role, this.runtime.worker())
      if (role === "effects") runners.set(role, this.runtime.effectWorker())
      if (role === "reminders") runners.set(role, this.runtime.reminderScheduler())
      if (role === "broadcasts") runners.set(role, this.runtime.broadcastWorker())
    }
    return runners
  }
}

function assertRole(role: string): asserts role is TestHelperRole {
  if (role === "actors" || role === "effects" || role === "reminders" || role === "broadcasts") {
    return
  }
  throw new TypeError(`unknown test helper role ${JSON.stringify(role)}`)
}
