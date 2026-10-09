import { Actor } from "solid-objects"

type Finding = { findingId: string; note: string }

export class Inspection extends Actor {
  static override readonly actorType = "Inspection"

  findings: Finding[] = []

  record({ findingId, note }: Finding): number {
    if (this.findings.some((finding) => finding.findingId === findingId)) {
      return this.findings.length
    }
    this.findings = [...this.findings, { findingId, note }]
    return this.findings.length
  }
}
