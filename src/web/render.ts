import type { DashboardChartLibrary, DashboardRenderer, DashboardTab } from "./types.js"
import type {
  DashboardInstanceDetail,
  DashboardPageResult,
  DashboardRecord,
  DashboardStatistics,
} from "./store.js"

interface ViewOptions {
  readonly mountPath: string
  readonly currentPath: string
  readonly nonce: string
  readonly csrfToken?: string
  readonly readOnly: boolean
  readonly tabs: readonly DashboardTab[]
  readonly renderers: Readonly<Record<string, DashboardRenderer>>
  readonly chartLibrary: DashboardChartLibrary
  readonly statistics: DashboardStatistics
}

interface RecordsPageOptions {
  readonly title: string
  readonly page: DashboardPageResult
  readonly columns: readonly Column[]
  readonly status?: string | null
  readonly statuses?: readonly string[]
  readonly extraQuery?: Readonly<Record<string, string | null | undefined>>
}

interface Column {
  readonly key: string
  readonly label: string
  readonly kind?: "actor" | "date" | "duration" | "json" | "link" | "paused" | "status"
  readonly path?: string
}

export class DashboardView {
  constructor(private readonly options: ViewOptions) {}

  get nonce(): string {
    return this.options.nonce
  }

  page(options: { title: string; content: string; error?: string }): string {
    const renderedContent = this.render({
      name: "layout_content",
      model: { title: options.title },
      defaultHtml: options.content,
    })
    const chartSource = this.options.chartLibrary.url
    const chartTag =
      chartSource && this.options.currentPath === "/"
        ? `<script defer nonce="${escapeHtml(this.options.nonce)}" src="${escapeHtml(this.assetPath(chartSource))}"${integrityAttributes(this.options.chartLibrary)}></script><script defer nonce="${escapeHtml(this.options.nonce)}" src="${escapeHtml(this.path("/assets/charts.js"))}"></script>`
        : ""
    const error = options.error
      ? `<div class="flash-error" role="alert">${escapeHtml(options.error)}</div>`
      : ""
    const navigation = this.options.tabs
      .map((tab) => {
        const current =
          tab.path === "/"
            ? this.options.currentPath === "/"
            : this.options.currentPath.startsWith(tab.path)
        return `<a href="${escapeHtml(this.path(tab.path))}"${current ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}</a>`
      })
      .join("")
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)} · Solid Objects</title><link rel="stylesheet" href="${escapeHtml(this.path("/assets/application.css"))}"></head><body data-stats-path="${escapeHtml(this.path("/stats"))}"><header><h1>Solid Objects</h1><p>Operator dashboard${this.options.readOnly ? " · Read only" : ""}</p></header><div class="shell"><nav aria-label="Dashboard">${navigation}</nav><main>${error}<div class="page-heading"><h2>${escapeHtml(options.title)}</h2><button class="live-toggle button-secondary" type="button" data-poll-toggle aria-pressed="false">Live</button></div>${this.summary()}${renderedContent}</main></div><script defer nonce="${escapeHtml(this.options.nonce)}" src="${escapeHtml(this.path("/assets/application.js"))}"></script>${chartTag}</body></html>`
  }

  dashboard(model: DashboardRecord): string {
    const instancesByType = rows(model.instancesByType)
    const instanceChart = Object.fromEntries(
      instancesByType.map((record) => [text(record.actor_type), numeric(record.count)]),
    )
    const processRows = rows(model.processes)
    const deadLetterRows = rows(model.deadLetters)
    const html = `<div class="grid"><section class="panel"><h3>Instances by actor type</h3><div class="panel-body">${this.chart("instances_by_type", instanceChart)}</div></section><section class="panel"><h3>Mailbox depth</h3><div class="panel-body">${this.chart("mailbox_depth", { Ready: this.options.statistics.mailbox.ready, Due: this.options.statistics.mailbox.due, Claimed: this.options.statistics.mailbox.claimed })}</div></section></div><section class="panel"><h3>Runtime work</h3><div class="panel-body">${this.chart("work_by_status", { Effects: this.options.statistics.effects, Broadcasts: this.options.statistics.broadcasts, Reminders: this.options.statistics.reminders })}</div></section>${this.tablePanel({ title: "Recent processes", records: processRows, columns: processColumns() })}${this.tablePanel({ title: "Recent dead letters", records: deadLetterRows, columns: deadLetterColumns() })}`
    return this.render({ name: "dashboard", model, defaultHtml: html })
  }

  instances(page: DashboardPageResult, search: URLSearchParams): string {
    const filters = `<form class="filters" method="get" action="${escapeHtml(this.path("/instances"))}"><input name="actor_type" placeholder="Actor type" value="${escapeHtml(search.get("actor_type") ?? "")}"><input name="actor_id" placeholder="Actor ID contains" value="${escapeHtml(search.get("actor_id") ?? "")}"><button type="submit">Filter</button></form>`
    const body = this.recordsPage({
      title: "Instances",
      page,
      columns: instanceColumns(),
      extraQuery: {
        actor_type: search.get("actor_type"),
        actor_id: search.get("actor_id"),
      },
    })
    return this.render({
      name: "instances",
      model: { page, search },
      defaultHtml: `${filters}${body}`,
    })
  }

  recordsPage(options: RecordsPageOptions): string {
    const filter = options.statuses
      ? `<form class="filters" method="get"><select name="status"><option value="">All statuses</option>${options.statuses.map((status) => `<option value="${escapeHtml(status)}"${options.status === status ? " selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select><button type="submit">Filter</button></form>`
      : ""
    return `${filter}${this.table(options.page.records, options.columns)}${this.pagination(options.page, options.extraQuery ?? { status: options.status })}`
  }

  instance(detail: DashboardInstanceDetail): string {
    const instance = detail.instance
    const state = jsonValue(instance.state)
    const status = instanceStatus(instance)
    const action = status === "paused" ? "resume" : "pause"
    const actionLabel = status === "paused" ? "Resume instance" : "Pause instance"
    const form = this.options.readOnly
      ? ""
      : `<form class="inline" method="post" action="${escapeHtml(this.path(`/instances/${text(instance.id)}/${action}`))}">${this.csrfInput()}<button class="${action === "pause" ? "button-danger" : ""}" type="submit">${actionLabel}</button></form>`
    const detailHtml = `<section class="panel"><h3>${escapeHtml(actorLabel(instance))}</h3><div class="panel-body">${form}</div>${details({ Status: status, "State version": instance.state_version, Revision: instance.state_revision, Created: dateValue(instance.created_at_ms), Updated: dateValue(instance.updated_at_ms) })}<div class="panel-body">${jsonBlock(state)}</div></section>${this.tablePanel({ title: "Ready mailbox", records: detail.readyMessages, columns: messageColumns() })}${this.tablePanel({ title: "Claimed mailbox", records: detail.claimedMessages, columns: messageColumns() })}${this.tablePanel({ title: "Recent messages", records: detail.recentMessages, columns: messageColumns() })}${this.tablePanel({ title: "Reminders", records: detail.reminders, columns: reminderColumns() })}${this.tablePanel({ title: "Effects", records: detail.effects, columns: effectColumns() })}${this.tablePanel({ title: "Broadcasts", records: detail.broadcasts, columns: broadcastColumns() })}${this.tablePanel({ title: "Dead letters", records: detail.deadLetters, columns: deadLetterColumns() })}`
    return this.render({ name: "instance", model: { detail }, defaultHtml: detailHtml })
  }

  message(record: DashboardRecord): string {
    const html = `<section class="panel"><h3>${escapeHtml(text(record.operation))}</h3>${details({ ID: record.id, Actor: actorLabel(record), Membership: record.membership, Delivery: record.delivery_mode, Sequence: record.sequence, Attempts: `${text(record.attempt_count)} / ${text(record.max_attempts)}`, Created: dateValue(record.created_at_ms), Completed: dateValue(record.completed_at_ms) })}<div class="panel-body"><h3>Arguments</h3>${jsonBlock(jsonValue(record.arguments))}<h3>Result</h3>${jsonBlock(jsonValue(record.result))}<h3>Rejection</h3>${jsonBlock(jsonValue(record.rejection))}<h3>Error</h3>${jsonBlock(jsonValue(record.error))}</div></section>`
    return this.render({ name: "message", model: { record }, defaultHtml: html })
  }

  deadLetter(record: DashboardRecord, error?: string): string {
    const retry = record.retried_message_id
      ? `<p>Retried as ${escapeHtml(text(record.retried_message_id))}</p>`
      : this.options.readOnly
        ? ""
        : `<form class="inline" method="post" action="${escapeHtml(this.path(`/dead-letters/${text(record.id)}/retry`))}">${this.csrfInput()}<button type="submit">Retry dead letter</button></form>`
    const html = `${error ? `<div class="flash-error">${escapeHtml(error)}</div>` : ""}<section class="panel"><h3>${escapeHtml(text(record.operation))}</h3>${details({ ID: record.id, "Message ID": record.message_id, Actor: actorLabel(record), Delivery: record.delivery_mode, Attempts: record.attempts, Created: dateValue(record.created_at_ms) })}<div class="panel-body">${retry}<h3>Arguments</h3>${jsonBlock(jsonValue(record.arguments))}<h3>Error</h3>${jsonBlock(jsonValue(record.error))}</div></section>`
    return this.render({ name: "dead_letter", model: { record, error }, defaultHtml: html })
  }

  path(path: string): string {
    if (path === "/") return this.options.mountPath || "/"
    return `${this.options.mountPath}${path}`
  }

  private summary(): string {
    const statistics = this.options.statistics
    const values = [
      ["Instances", "instances.total", statistics.instances.total],
      ["Ready", "mailbox.ready", statistics.mailbox.ready],
      ["Due", "mailbox.due", statistics.mailbox.due],
      ["Claimed", "mailbox.claimed", statistics.mailbox.claimed],
      ["Mailbox lag", "mailbox.latency", statistics.mailbox.latency, "duration"],
      ["Dead letters", "deadLetters.total", statistics.deadLetters.total],
    ] as const
    return `<section class="summary">${values.map(([label, key, value, format]) => `<div class="stat"><span>${label}</span><strong data-statistic="${key}"${format ? ` data-format="${format}"` : ""}>${format === "duration" ? duration(numeric(value)) : number(numeric(value))}</strong></div>`).join("")}</section>`
  }

  private tablePanel(options: {
    title: string
    records: readonly DashboardRecord[]
    columns: readonly Column[]
  }): string {
    return `<section class="panel"><h3>${escapeHtml(options.title)}</h3>${this.table(options.records, options.columns)}</section>`
  }

  private table(records: readonly DashboardRecord[], columns: readonly Column[]): string {
    if (records.length === 0) return '<p class="empty">No records</p>'
    const header = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")
    const body = records
      .map(
        (record) =>
          `<tr>${columns.map((column) => `<td>${this.cell(record, column)}</td>`).join("")}</tr>`,
      )
      .join("")
    return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`
  }

  private cell(record: DashboardRecord, column: Column): string {
    const value = record[column.key]
    if (column.kind === "actor") return escapeHtml(actorLabel(record))
    if (column.kind === "date") return time(value)
    if (column.kind === "duration") return duration(numeric(value))
    if (column.kind === "json") return jsonBlock(jsonValue(value))
    if (column.kind === "status") return statusLabel(text(value))
    if (column.kind === "paused") return statusLabel(numeric(value) === 0 ? "active" : "paused")
    if (column.kind === "link") {
      const prefix = column.path ?? ""
      return `<a href="${escapeHtml(this.path(`${prefix}/${text(record.id)}`))}">${escapeHtml(text(value))}</a>`
    }
    return escapeHtml(text(value))
  }

  private pagination(
    page: DashboardPageResult,
    query: Readonly<Record<string, string | null | undefined>>,
  ): string {
    if (page.total === 0) return ""
    const parameters = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value) parameters.set(key, value)
    }
    parameters.set("per_page", String(page.perPage))
    const link = (target: number, label: string) => {
      parameters.set("page", String(target))
      return `<a class="button button-secondary" href="?${escapeHtml(parameters.toString())}">${label}</a>`
    }
    return `<div class="pagination"><span>${number((page.page - 1) * page.perPage + 1)}–${number(Math.min(page.page * page.perPage, page.total))} of ${number(page.total)}</span><span>${page.page > 1 ? link(page.page - 1, "Previous") : ""} ${page.page < page.lastPage ? link(page.page + 1, "Next") : ""}</span></div>`
  }

  private csrfInput(): string {
    const csrfToken = this.options.csrfToken
    if (!csrfToken) throw new TypeError("read-write dashboard rendering requires a session")
    return `<input type="hidden" name="authenticity_token" value="${escapeHtml(csrfToken)}">`
  }

  private chart(name: string, values: unknown): string {
    if (!this.options.chartLibrary.url) return ""
    return `<div class="chart-frame"><canvas data-chart="${escapeHtml(name)}" data-chart-values='${escapeHtml(jsonString(values))}'></canvas></div>`
  }

  private assetPath(path: string): string {
    return path.includes("//") ? path : this.path(path)
  }

  private render(options: {
    name: string
    model: Record<string, unknown>
    defaultHtml: string
  }): string {
    const renderer = this.options.renderers[options.name]
    return renderer
      ? renderer({
          name: options.name,
          model: Object.freeze(options.model),
          defaultHtml: options.defaultHtml,
        })
      : options.defaultHtml
  }
}

export function escapeHtml(value: unknown): string {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function integrityAttributes(library: DashboardChartLibrary): string {
  if (!library.integrity) return ""
  return ` integrity="${escapeHtml(library.integrity)}" crossorigin="anonymous" referrerpolicy="no-referrer"`
}

function details(values: Record<string, unknown>): string {
  return `<dl class="details">${Object.entries(values)
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value ?? "—")}</dd>`)
    .join("")}</dl>`
}

function jsonBlock(value: unknown): string {
  if (value === null || value === undefined || value === "") return "<p>—</p>"
  const output = jsonString(value)
  const truncated = output.length > 2_000 ? `${output.slice(0, 2_000)}…` : output
  return `<pre class="payload">${escapeHtml(truncated)}</pre>`
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function jsonString(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item),
    2,
  )
}

function rows(value: unknown): readonly DashboardRecord[] {
  return Array.isArray(value) ? (value as DashboardRecord[]) : []
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ""
  return typeof value === "bigint" ? String(value) : String(value)
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  return Number(value ?? 0)
}

function number(value: number): string {
  return value.toLocaleString("en-US")
}

function duration(value: number): string {
  if (value < 60) return `${value.toFixed(3)} s`
  return `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`
}

function time(value: unknown): string {
  const date = dateValue(value)
  if (date === "—") return date
  return `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`
}

function dateValue(value: unknown): string {
  const milliseconds = numeric(value)
  if (!milliseconds) return "—"
  return new Date(milliseconds).toISOString()
}

function actorLabel(record: DashboardRecord): string {
  return `${text(record.actor_type)} / ${text(record.actor_id)}`
}

function statusLabel(value: string): string {
  return `<span class="status status-${escapeHtml(value)}">${escapeHtml(value)}</span>`
}

function instanceStatus(record: DashboardRecord): string {
  if (numeric(record.paused) !== 0) return "paused"
  if (!record.activation_owner_id || !numeric(record.activation_expires_at_ms)) return "idle"
  return numeric(record.activation_expires_at_ms) >= Date.now() ? "activated" : "expired"
}

function instanceColumns(): readonly Column[] {
  return [
    { key: "actor_type", label: "Actor", kind: "link", path: "/instances" },
    { key: "actor_id", label: "Actor ID" },
    { key: "state_revision", label: "Revision" },
    { key: "paused", label: "Status", kind: "paused" },
    { key: "updated_at_ms", label: "Updated", kind: "date" },
  ]
}

function messageColumns(): readonly Column[] {
  return [
    { key: "operation", label: "Operation", kind: "link", path: "/messages" },
    { key: "actor_id", label: "Actor ID" },
    { key: "delivery_mode", label: "Delivery" },
    { key: "sequence", label: "Sequence" },
    { key: "attempt_count", label: "Attempts" },
  ]
}

function reminderColumns(): readonly Column[] {
  return [
    { key: "operation", label: "Operation" },
    { key: "status", label: "Status", kind: "status" },
    { key: "run_at_ms", label: "Run at", kind: "date" },
    { key: "occurrence", label: "Occurrence" },
  ]
}

function effectColumns(): readonly Column[] {
  return [
    { key: "name", label: "Effect" },
    { key: "status", label: "Status", kind: "status" },
    { key: "attempt_count", label: "Attempts" },
    { key: "available_at_ms", label: "Available", kind: "date" },
  ]
}

function broadcastColumns(): readonly Column[] {
  return [
    { key: "actor_type", label: "Actor" },
    { key: "actor_id", label: "Actor ID" },
    { key: "status", label: "Status", kind: "status" },
    { key: "state_revision", label: "Revision" },
  ]
}

function deadLetterColumns(): readonly Column[] {
  return [
    { key: "operation", label: "Operation", kind: "link", path: "/dead-letters" },
    { key: "actor_type", label: "Actor" },
    { key: "actor_id", label: "Actor ID" },
    { key: "attempts", label: "Attempts" },
    { key: "created_at_ms", label: "Failed", kind: "date" },
  ]
}

function processColumns(): readonly Column[] {
  return [
    { key: "kind", label: "Role" },
    { key: "hostname", label: "Host" },
    { key: "host_process_id", label: "PID" },
    { key: "shutdown_state", label: "State", kind: "status" },
    { key: "heartbeat_at_ms", label: "Heartbeat", kind: "date" },
  ]
}

export const DASHBOARD_COLUMNS = Object.freeze({
  messages: messageColumns(),
  reminders: reminderColumns(),
  effects: effectColumns(),
  broadcasts: broadcastColumns(),
  deadLetters: deadLetterColumns(),
  processes: processColumns(),
})
