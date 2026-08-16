import type { ChildProcess } from "node:child_process"

export function waitForWorkerReady(worker: ChildProcess): Promise<void> {
  const priorExit = workerExitError(worker, "before ready")
  if (priorExit) return Promise.reject(priorExit)

  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      worker.off("error", onError)
      worker.off("exit", onExit)
      worker.off("message", onMessage)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(workerExitError({ exitCode: code, signalCode: signal }, "before ready"))
    }
    const onMessage = (message: string) => {
      if (message !== "ready") return
      cleanup()
      resolvePromise()
    }
    worker.once("error", onError)
    worker.once("exit", onExit)
    worker.on("message", onMessage)
  })
}

export function waitForWorkerExit(worker: ChildProcess): Promise<void> {
  const priorExit = workerExitError(worker)
  if (priorExit) {
    return worker.exitCode === 0 ? Promise.resolve() : Promise.reject(priorExit)
  }

  return new Promise((resolvePromise, reject) => {
    worker.once("error", reject)
    worker.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(workerExitError({ exitCode: code, signalCode: signal }))
    })
  })
}

function workerExitError(
  worker: Pick<ChildProcess, "exitCode" | "signalCode">,
  phase?: string,
): Error | undefined {
  if (worker.exitCode === null && worker.signalCode === null) return undefined
  const suffix = phase ? ` ${phase}` : ""
  return new Error(
    `benchmark worker exited${suffix} with code ${worker.exitCode} and signal ${worker.signalCode}`,
  )
}
