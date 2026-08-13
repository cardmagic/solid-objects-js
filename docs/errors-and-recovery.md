# Errors and recovery

All library errors extend `SolidObjectsError`. Ordinary validation failures may
also use `TypeError`. Catch the narrow class whose recovery you can perform;
do not parse error messages.

## Caller-facing control flow

| Error                   | Meaning                                                                                                          | Recovery                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Rejected`              | Actor domain refusal. The turn rolled back and will not retry.                                                   | Inspect `code`, frozen `details`, and `messageId`; correct the request or present the refusal.                                |
| `Unauthorized`          | The relevant deny-by-default policy refused the operation.                                                       | Reauthenticate or change the application policy; actor IDs are not credentials.                                               |
| `SyncEnqueueTimeout`    | The enqueue transaction did not commit before the call deadline.                                                 | It is safe to retry with an idempotency key; no durable message exists from this attempt.                                     |
| `SyncTimeout`           | Enqueue committed but result waiting expired.                                                                    | Retain `messageReference`, inspect `details.waitingOn`, and call `wait()` again later.                                        |
| `MessageFailed`         | The durable operation failed permanently.                                                                        | Correlate `messageId`, inspect persisted `details`, then inspect or retry its dead letter under administration authorization. |
| `ActorDestroyed`        | An authorized waiter lost the actor incarnation it was waiting on.                                               | Decide whether the new incarnation should receive a new operation.                                                            |
| `IdempotencyConflict`   | One actor reused a key for different arguments, operation, or delivery mode.                                     | Reuse a key only for the identical request.                                                                                   |
| `MailboxFull`           | One actor reached `maxMailboxLength`.                                                                            | Apply admission control or wait for existing work; do not blindly increase the cap.                                           |
| `PayloadTooLarge`       | Arguments, state, result, snapshot getter, effect result, or personalized payload exceeded its configured limit. | Reduce the JSON value or deliberately raise the corresponding limit.                                                          |
| `SyncInsideTransaction` | A committed call or message wait would self-deadlock inside this adapter's transaction.                          | Finish the transaction first or stage actor-owned work through a commit action.                                               |

`MessageReference.status()`, `result()`, and `wait()` reauthorize the stored
operation. `result()` returns `undefined` while work is nonterminal, returns the
committed result when complete, and raises `Rejected` or `MessageFailed` for a
terminal refusal or failure. `wait()` blocks until the same terminal outcomes
or its deadline.

## Definition and programming errors

These errors normally require a code or deployment correction:

- `InvalidActor`: invalid actor type, state version, migration declaration,
  member name, payload declaration, or duplicate registration.
- `UnknownActorType`, `UnknownOperation`, `UnknownEffect`, and
  `UnknownCommitAction`: deployed registration does not match durable work or
  code attempted an undeclared operation.
- `StateMigrationError`: migration path is missing or failed, or stored state
  is newer than the process code.
- `ActorCallCycle`: actor code tried to make a synchronous actor call, use a
  reference's `send`, or destroy an actor. Stage delivery with `this.sendTo()`.
- `QueryMutatedState`: a field/getter query, snapshot, observable, or payload
  projection changed state or staged durable work.
- `ApplicationWriteForbidden`: actor-owned code attempted a write through
  `guardApplicationDatabase()` outside the fenced commit-action connection.
- `InvalidPayload`, `InvalidPayloadBroadcast`, and
  `UnknownPayloadBroadcast`: a value or requested personalized projection did
  not satisfy the JSON and declaration contract.
- `UnsupportedDatabase`: an adapter reports a database family the runtime does
  not support.

`NonRetryableError` is also the application extension point for an unexpected
failure that retry cannot resolve:

```typescript
import { NonRetryableError } from "solid-objects"

class InvalidWorkflowDefinition extends NonRetryableError {}
```

Throwing it from an operation rolls back the turn and dead-letters immediately.
Prefer `this.reject()` for expected domain decisions because it preserves a
stable public code and does not classify the operation as failed.

## Lease, database, and administration errors

- `LostActivation` means the worker no longer owns the commit fence. The
  runtime discards the stale result; application code should not suppress it.
- `DatabaseDeadlineExceeded` is the adapter-level deadline used to construct
  synchronous timeout behavior.
- `UnknownDeadLetter` and `UnknownReminder` mean an authorized administration
  lookup found no record.
- `ReminderNotPaused` means only a completed reminder remains; schedule it
  again through its actor instead of resuming it.

Realtime protocol validation uses `TypeError` for malformed subscription or
browser envelopes. Server delivery failures are isolated to the session and
reported through instrumentation; one connection cannot fail durable
broadcast processing for the others.

## Retry ownership

An ordinary thrown error is retryable until `maxAttempts`. Each failure rolls
back state and staged work and preserves strict ordering, so later messages do
not pass the poison message. After terminal failure, the dead letter records
the arguments, attempts, and error. `runtime.deadLetters.retry(id)` creates one
linked replacement message; repeating the call returns the same replacement.

Effects are different: they execute outside the actor transaction and are at
least once. Deduplicate external work with the stable `EffectContext.id`.
