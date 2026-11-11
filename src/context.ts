import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context as HonoContext } from 'hono'
import { ImproperlyConfigured } from './errors'
import type { GhuriSettings } from './settings'

export type Env = Record<string, any>

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/** Everything that belongs to the current request (or CLI/test run). */
export interface GhuriContext {
  env: Env
  settings: GhuriSettings
  executionCtx?: ExecutionContextLike
  request?: Request
  hono?: HonoContext
  /** Per-request cache. Packages store their own state under a unique symbol. */
  state: Map<string | symbol, unknown>
}

// One storage per process, even if the module is loaded twice (e.g. CJS/ESM or bundling quirks).
const STORAGE_KEY = Symbol.for('ghuri.core.contextStorage')
const GLOBAL_KEY = Symbol.for('ghuri.core.globalContext')
const g = globalThis as any
const storage: AsyncLocalStorage<GhuriContext> = (g[STORAGE_KEY] ??= new AsyncLocalStorage<GhuriContext>())

export function runWithContext<T>(ctx: GhuriContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** Fallback context used outside requests (CLI, scripts, tests). */
export function setGlobalContext(ctx: GhuriContext | undefined): void {
  g[GLOBAL_KEY] = ctx
}

export function tryGetContext(): GhuriContext | undefined {
  return storage.getStore() ?? (g[GLOBAL_KEY] as GhuriContext | undefined)
}

export function getContext(): GhuriContext {
  const ctx = tryGetContext()
  if (!ctx) {
    throw new ImproperlyConfigured(
      'No Ghuri context. Code that touches settings, the database or storage must run inside a request ' +
        'handled by createApp(), inside runWithContext(), or after app.setup(env) (CLI/tests).',
    )
  }
  return ctx
}

export function getEnv(): Env {
  return getContext().env
}

export function createContext(init: Omit<GhuriContext, 'state'> & { state?: GhuriContext['state'] }): GhuriContext {
  return { ...init, state: init.state ?? new Map() }
}
