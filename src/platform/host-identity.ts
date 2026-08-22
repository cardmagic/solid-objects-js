export interface HostIdentity {
  hostname: string
  hostProcessId: number
  runtimeVersion: string
}

export class HostIdentityMissing extends Error {
  constructor() {
    super(
      "no host identity is registered; " +
        "import a platform entry point before actor or database work starts",
    )
    this.name = "HostIdentityMissing"
  }
}

let registeredIdentity: HostIdentity | undefined

export function registerHostIdentity(identity: HostIdentity): void {
  registeredIdentity = identity
}

export function hostIdentity(): HostIdentity {
  if (!registeredIdentity) throw new HostIdentityMissing()
  return registeredIdentity
}
