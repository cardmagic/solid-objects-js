import type { JsonObject } from "./types.js"

export interface ProcessRow {
  id: string
  kind: string
  hostname: string
  host_process_id: number | bigint
  metadata: string
  started_at_ms: number | bigint
  heartbeat_at_ms: number | bigint
  shutdown_requested_at_ms: number | bigint | null
  stopped_at_ms: number | bigint | null
  shutdown_state: "running" | "draining" | "stopped"
}

export interface InstanceRow {
  id: string
  actor_type: string
  actor_id: string
  state: string
  state_version: number | bigint
  state_revision: number | bigint
  next_message_sequence: number | bigint
  activation_owner_id: string | null
  activation_token: string | null
  activation_expires_at_ms: number | bigint | null
  activation_generation: number | bigint
  paused: number | bigint
  created_at_ms: number | bigint
  updated_at_ms: number | bigint
}

export interface MessageRow {
  id: string
  request_id: string
  idempotency_key: string | null
  instance_id: string
  actor_type: string
  actor_id: string
  sequence: number | bigint
  operation: string
  delivery_mode: "async" | "sync" | "internal"
  arguments: string
  result: string | null
  rejection: string | null
  error: string | null
  attempt_count: number | bigint
  max_attempts: number | bigint
  completed_at_ms: number | bigint | null
  created_at_ms: number | bigint
  updated_at_ms: number | bigint
}

export interface DeadLetterRow {
  id: string
  message_id: string
  instance_id: string
  actor_type: string
  actor_id: string
  operation: string
  delivery_mode: "async" | "sync" | "internal"
  arguments: string
  attempts: number | bigint
  error: string
  created_at_ms: number | bigint
  retried_message_id: string | null
}

export interface ClaimedTurn {
  instance: InstanceRow
  message: MessageRow
  processId: string
  activationToken: string
  activationGeneration: bigint
  nowMilliseconds: number
}

export interface ActivationLease {
  instanceId: string
  processId: string
  activationToken: string
  activationGeneration: bigint
}

export interface EnqueueInput {
  actorType: string
  actorId: string
  operation: string
  deliveryMode: "async" | "sync" | "internal"
  arguments: JsonObject
  initialState?: JsonObject
  stateVersion?: number
  availableAtMilliseconds?: number
  idempotencyKey?: string
}

export interface EffectRow {
  id: string
  message_id: string
  instance_id: string
  actor_type: string
  actor_id: string
  name: string
  arguments: string
  success_operation: string | null
  failure_operation: string | null
  status: "pending" | "processing" | "completed" | "dead"
  attempt_count: number | bigint
  max_attempts: number | bigint
  available_at_ms: number | bigint
  claimed_by: string | null
  result: string | null
  error: string | null
}

export interface ReminderRow {
  id: string
  instance_id: string
  actor_type: string
  actor_id: string
  operation: string
  run_at_ms: number | bigint
  arguments: string
  interval_ms: number | bigint | null
  missed_policy: "latest" | "all"
  occurrence: number | bigint
  status: "scheduled" | "paused" | "completed"
  claimed_by: string | null
  claimed_at_ms: number | bigint | null
  error: string | null
}

export interface BroadcastRow {
  id: string
  message_id: string
  instance_id: string
  actor_type: string
  actor_id: string
  state_revision: number | bigint
  observables: string
  status: "pending" | "processing" | "delivered" | "dead"
  attempt_count: number | bigint
  available_at_ms: number | bigint
  claimed_by: string | null
  error: string | null
}
