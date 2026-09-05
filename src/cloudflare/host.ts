import "./platform.js"
import { DurableObject } from "cloudflare:workers"
import type { ActorClass } from "../actor.js"
import { withRuntime } from "../context.js"
import { buildCloudflareSettings, type CloudflareConfiguration } from "./configuration.js"
import { ActorEngine } from "./engine.js"
import { encodeError, type ActorHost, type HostRequest, type RpcReply } from "./protocol.js"
import { ActorStorage } from "./storage.js"

export function createDurableObjectsHost<Environment>(options: {
  actors: readonly ActorClass[]
  configure: (environment: Environment) => CloudflareConfiguration
}): new (
  context: DurableObjectState,
  environment: Environment,
) => DurableObject<Environment> & ActorHost {
  return class SolidObjectsActorHost extends DurableObject<Environment> {
    readonly #engine: ActorEngine

    constructor(context: DurableObjectState, environment: Environment) {
      super(context, environment)
      this.#engine = new ActorEngine(
        new ActorStorage(this.ctx.storage, buildCloudflareSettings(options.configure(this.env))),
        options.actors,
      )
    }

    async request(input: HostRequest): Promise<RpcReply> {
      try {
        const value = await withRuntime(this.#engine.runtime, () => this.#engine.request(input))
        this.ctx.waitUntil(this.#pump().catch(() => undefined))
        return { ok: true, value }
      } catch (error) {
        return encodeError(error)
      }
    }

    override async alarm(): Promise<void> {
      await this.#pump()
    }

    async #pump(): Promise<void> {
      try {
        await this.#engine.pump()
      } catch (error) {
        const scheduled = await this.ctx.storage.getAlarm()
        await this.ctx.storage.setAlarm(Math.min(scheduled ?? Infinity, Date.now() + 30_000))
        this.#engine.settings.logger.error({
          event: "solid_objects.alarm.failed",
          errorName: error instanceof Error ? error.name : "Error",
        })
        throw error
      }
    }
  }
}
