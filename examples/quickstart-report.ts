export interface QuickstartSummary {
  sameIdentityCalls: number
  sameIdentityFinalState: number
  independentIdentitiesOverlapped: boolean
  temporaryStateRemoved: boolean
}

interface QuickstartCheck {
  passed: boolean
  title: string
  detail: readonly string[]
}

const INSTALL_COMMAND = "npm install solid-objects"
const AGENT_PROMPT = "where would the solid-objects library be best used in this app?"
const DOCUMENTATION_URL = "https://solidobjects.dev/node"

export function formatQuickstartPlan(plan: {
  sameIdentityCalls: number
  actorSource: string
}): string {
  return [
    "Solid Objects quickstart",
    "",
    "This command will:",
    "",
    "  1. create a temporary SQLite database;",
    `  2. send ${plan.sameIdentityCalls} concurrent calls to one identity;`,
    "  3. run two other identities at the same time;",
    "  4. close the runtime and delete the temporary database.",
    "",
    "No server, container, or configuration is needed.",
    "",
    "The actor it runs:",
    "",
    ...plan.actorSource.split("\n").map((line) => `  ${line}`.trimEnd()),
    "",
    "",
  ].join("\n")
}

export function formatQuickstartPrompt(): string {
  return "Run it now? [Y/n] "
}

export function answerAllowsRun(answer: string): boolean {
  const value = answer.trim().toLowerCase()
  if (value === "") return true
  return value === "y" || value === "yes"
}

export function formatQuickstartStop(): string {
  return ["", "Nothing ran. No database and no files were created.", ""].join("\n")
}

export function formatQuickstartReport(summary: QuickstartSummary): string {
  const results = checks(summary)
  return [
    "Results",
    "",
    ...results.flatMap(checkLines),
    "",
    "Each line above is an assertion, not a print. The command exits with a",
    "non-zero code when one of them fails.",
    "",
    ...meaning(results),
    "Add it to your app",
    "",
    `  ${INSTALL_COMMAND}`,
    "",
    "Or tell your agent",
    "",
    `  ${AGENT_PROMPT}`,
    "",
    `Docs: ${DOCUMENTATION_URL}`,
    "",
  ].join("\n")
}

function meaning(results: readonly QuickstartCheck[]): string[] {
  if (results.some((check) => !check.passed)) return []
  return [
    "What each PASS means",
    "",
    "  Two requests on the same cart cannot overwrite each other.",
    "  That identity has one durable mailbox, so its calls commit one at a",
    "  time and no update is lost.",
    "",
    "  Unrelated identities do not wait for that mailbox.",
    "  The order is per identity, not global.",
    "",
    "  The state lives in an ordinary SQL database, so it survives a restart.",
    "",
  ]
}

function checkLines(check: QuickstartCheck): string[] {
  const result = check.passed ? "PASS" : "FAIL"
  return [`${result}  ${check.title}`, ...check.detail.map((line) => `      ${line}`)]
}

function checks(summary: QuickstartSummary): QuickstartCheck[] {
  return [
    {
      passed: summary.sameIdentityFinalState === summary.sameIdentityCalls,
      title: `${summary.sameIdentityCalls} concurrent calls to one identity`,
      detail: sameIdentityDetail(summary),
    },
    {
      passed: summary.independentIdentitiesOverlapped,
      title: "Two different identities ran at the same time",
      detail: overlapDetail(summary),
    },
    {
      passed: summary.temporaryStateRemoved,
      title: "Temporary state removed",
      detail: cleanupDetail(summary),
    },
  ]
}

function sameIdentityDetail(summary: QuickstartSummary): string[] {
  if (summary.sameIdentityFinalState !== summary.sameIdentityCalls) {
    return [
      `The committed state is ${summary.sameIdentityFinalState} after ${summary.sameIdentityCalls} calls.`,
      "The runtime lost an update.",
    ]
  }
  return [
    "They ran in order on one mailbox.",
    `The committed state is ${summary.sameIdentityFinalState}.`,
    `The return values were the complete sequence 1 through ${summary.sameIdentityCalls}.`,
  ]
}

function overlapDetail(summary: QuickstartSummary): string[] {
  if (!summary.independentIdentitiesOverlapped) {
    return ["Their execution windows did not overlap."]
  }
  return [
    "Their execution windows overlapped, so an unrelated identity",
    "never waits behind this one.",
  ]
}

function cleanupDetail(summary: QuickstartSummary): string[] {
  if (!summary.temporaryStateRemoved) {
    return ["The temporary SQLite database is still on disk."]
  }
  return ["The scoped temporary SQLite database was deleted at exit."]
}
