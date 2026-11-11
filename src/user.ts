import type { Context } from 'hono'
import { tryGetContext } from './context'

/** What rest/admin/agents need from a user, without depending on @ghuri/auth. */
export interface RequestUser {
  pk: unknown
  isAuthenticated: boolean
  isAnonymous: boolean
  isActive?: boolean
  isStaff?: boolean
  isSuperuser?: boolean
  username?: string
  hasPerm(perm: string, obj?: unknown): Promise<boolean>
  hasPerms?(perms: string[], obj?: unknown): Promise<boolean>
  hasModulePerms?(appLabel: string): Promise<boolean>
}

export class AnonymousUser implements RequestUser {
  readonly pk = null
  readonly id = null
  readonly username = ''
  readonly isAuthenticated = false
  readonly isAnonymous = true
  readonly isActive = false
  readonly isStaff = false
  readonly isSuperuser = false
  async hasPerm(): Promise<boolean> {
    return false
  }
  async hasPerms(): Promise<boolean> {
    return false
  }
  async hasModulePerms(): Promise<boolean> {
    return false
  }
  toString(): string {
    return 'AnonymousUser'
  }
}

export const anonymousUser: RequestUser = new AnonymousUser()

const USER_KEY = Symbol.for('ghuri.core.user')

/** The user of the current request (AnonymousUser if no authentication ran). */
export function getUser(c?: Context): RequestUser {
  const fromHono = c?.get?.('user' as never) as RequestUser | undefined
  if (fromHono) return fromHono
  const ctx = tryGetContext()
  const fromCtx = (ctx?.state.get(USER_KEY) as RequestUser | undefined) ?? (ctx?.hono?.get?.('user' as never) as RequestUser | undefined)
  return fromCtx ?? anonymousUser
}

export function setUser(c: Context | undefined, user: RequestUser): void {
  c?.set?.('user' as never, user as never)
  tryGetContext()?.state.set(USER_KEY, user)
}
