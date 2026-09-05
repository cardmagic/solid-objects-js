import type { SolidObjectsConfiguration } from "../configuration.js"
import type { EffectContext, JsonObject, Logger } from "../types.js"
import type { DurableObjectsBackend } from "./protocol.js"

export type EffectHandler = (
  argumentsValue: JsonObject,
  context: EffectContext,
) => unknown | Promise<unknown>

export type CloudflareConfiguration = Pick<
  SolidObjectsConfiguration,
  | "authorizeMessage"
  | "authorizeQuery"
  | "authorizeDestroy"
  | "authorizeSubscription"
  | "authorizeAdministration"
  | "instrumentation"
  | "logger"
  | "maxAttempts"
  | "maxMailboxLength"
  | "maxPayloadBytes"
  | "maxStateBytes"
  | "maxResultBytes"
  | "maxMessagesPerActivationPass"
  | "maxActivationDurationMilliseconds"
  | "retryDelayMilliseconds"
  | "messageRetentionMilliseconds"
  | "pruneBatchSize"
> & {
  backend: DurableObjectsBackend
  effects?: Readonly<Record<string, EffectHandler>>
}

export function buildCloudflareSettings(configuration: CloudflareConfiguration) {
  const settings = {
    ...configuration,
    authorizeMessage: configuration.authorizeMessage ?? (() => false),
    authorizeQuery: configuration.authorizeQuery ?? (() => false),
    authorizeDestroy: configuration.authorizeDestroy ?? (() => false),
    authorizeSubscription: configuration.authorizeSubscription ?? (() => false),
    authorizeAdministration: configuration.authorizeAdministration ?? (() => false),
    effects: configuration.effects ?? {},
    logger: configuration.logger ?? consoleLogger,
    maxAttempts: configuration.maxAttempts ?? 5,
    maxMailboxLength: configuration.maxMailboxLength ?? 10_000,
    maxPayloadBytes: configuration.maxPayloadBytes ?? 1_048_576,
    maxStateBytes: configuration.maxStateBytes ?? 1_048_576,
    maxResultBytes: configuration.maxResultBytes ?? 1_048_576,
    maxMessagesPerActivationPass: configuration.maxMessagesPerActivationPass ?? 50,
    maxActivationDurationMilliseconds: configuration.maxActivationDurationMilliseconds ?? 5_000,
    retryDelayMilliseconds:
      configuration.retryDelayMilliseconds ??
      ((attempt: number) => Math.min(2 ** (attempt - 1), 60) * 1_000),
    messageRetentionMilliseconds: configuration.messageRetentionMilliseconds ?? 30 * 86_400_000,
    pruneBatchSize: configuration.pruneBatchSize ?? 1_000,
  }
  for (const name of [
    "maxAttempts",
    "maxMailboxLength",
    "maxPayloadBytes",
    "maxStateBytes",
    "maxResultBytes",
    "maxMessagesPerActivationPass",
    "maxActivationDurationMilliseconds",
    "messageRetentionMilliseconds",
    "pruneBatchSize",
  ] as const) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  return settings
}

export type CloudflareSettings = ReturnType<typeof buildCloudflareSettings>

export const consoleLogger: Logger = {
  debug: (entry) => console.debug(entry),
  info: (entry) => console.info(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
}
