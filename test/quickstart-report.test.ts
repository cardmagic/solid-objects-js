import { describe, expect, it } from "vitest"
import {
  answerAllowsRun,
  formatQuickstartPlan,
  formatQuickstartPrompt,
  formatQuickstartReport,
  formatQuickstartStop,
} from "../examples/quickstart-report.js"

const passing = {
  sameIdentityCalls: 25,
  sameIdentityFinalState: 25,
  independentIdentitiesOverlapped: true,
  temporaryStateRemoved: true,
}

const actorSource = `class Counter extends Actor {
  count = 0

  increment(): number {
    this.count += 1
    return this.count
  }
}`

describe("formatQuickstartPlan", () => {
  it("shows the actor definition that the run will use", () => {
    const plan = formatQuickstartPlan({ sameIdentityCalls: 25, actorSource })

    expect(plan).toContain("The actor it runs")
    expect(plan).toContain("class Counter extends Actor {")
    expect(plan).toContain("    this.count += 1")
  })

  it("says what the command will do before it does it", () => {
    const plan = formatQuickstartPlan({ sameIdentityCalls: 25, actorSource })

    expect(plan).toContain("This command will")
    expect(plan).toContain("create a temporary SQLite database")
    expect(plan).toContain("send 25 concurrent calls to one identity")
    expect(plan).toContain("run two other identities at the same time")
    expect(plan).toContain("delete the temporary database")
  })

  it("states that the run needs no server and touches nothing else", () => {
    const plan = formatQuickstartPlan({ sameIdentityCalls: 25, actorSource })

    expect(plan).toContain("No server, container, or configuration is needed.")
  })
})

describe("the run confirmation", () => {
  it("asks before it does the work", () => {
    expect(formatQuickstartPrompt()).toContain("Run it now?")
  })

  it("accepts an empty answer and a yes", () => {
    expect(answerAllowsRun("")).toBe(true)
    expect(answerAllowsRun(" ")).toBe(true)
    expect(answerAllowsRun("y")).toBe(true)
    expect(answerAllowsRun("Y")).toBe(true)
    expect(answerAllowsRun("yes")).toBe(true)
  })

  it("refuses any other answer", () => {
    expect(answerAllowsRun("n")).toBe(false)
    expect(answerAllowsRun("no")).toBe(false)
    expect(answerAllowsRun("q")).toBe(false)
    expect(answerAllowsRun("later")).toBe(false)
  })

  it("says that nothing ran when the answer refuses", () => {
    expect(formatQuickstartStop()).toContain("Nothing ran.")
  })
})

describe("formatQuickstartReport", () => {
  it("explains what the passing checks mean for an application", () => {
    const report = formatQuickstartReport(passing)

    expect(report).toContain("What each PASS means")
    expect(report).toContain("cannot overwrite each other")
    expect(report).toContain("one durable mailbox")
    expect(report).toContain("The order is per identity, not global.")
  })

  it("omits the meaning section when a check did not hold", () => {
    const report = formatQuickstartReport({ ...passing, temporaryStateRemoved: false })

    expect(report).not.toContain("What each PASS means")
  })

  it("explains what each assertion proved", () => {
    const report = formatQuickstartReport(passing)

    expect(report).toContain("25 concurrent calls to one identity")
    expect(report).toContain("committed state is 25")
    expect(report).toContain("return values were the complete sequence 1 through 25")
    expect(report).toContain("Two different identities ran at the same time")
    expect(report).toContain("temporary SQLite database")
    expect(report.match(/^PASS  /gm)).toHaveLength(3)
  })

  it("marks a check that did not hold", () => {
    const report = formatQuickstartReport({ ...passing, independentIdentitiesOverlapped: false })

    expect(report).toContain("FAIL")
    expect(report.match(/^PASS  /gm)).toHaveLength(2)
  })

  it("reports the final state that the run committed", () => {
    const report = formatQuickstartReport({
      ...passing,
      sameIdentityCalls: 4,
      sameIdentityFinalState: 4,
    })

    expect(report).toContain("4 concurrent calls to one identity")
    expect(report).toContain("committed state is 4")
    expect(report).toContain("sequence 1 through 4")
  })

  it("tells the reader how to add the package to an application", () => {
    const report = formatQuickstartReport(passing)

    expect(report).toContain("Add it to your app")
    expect(report).toContain("npm install solid-objects")
    expect(report).toContain("Or tell your agent")
    expect(report).toContain("where would the solid-objects library be best used in this app?")
  })
})
