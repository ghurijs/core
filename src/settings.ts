import type { MiddlewareHandler } from 'hono'
import type { AppConfig, AppConfigClass } from './apps'
import { type Env, getContext } from './context'
import { ImproperlyConfigured } from './errors'

// These types are defined in their own modules (urls.ts, middleware.ts, cache.ts) by the core build;
// they are referenced structurally here to keep the seam module dependency-free.
export type UrlPatternsLike = unknown[]
export type MiddlewareLike = (new () => { handle(c: any, next: () => Promise<void>): Promise<Response | void> }) | MiddlewareHandler

/**
 * Project settings. Other packages add keys with declaration merging:
 *
 * ```ts
 * declare module '@ghuri/core' { interface GhuriSettings { DATABASES: Record<string, DatabaseConfig> } }
 * ```
 */
export interface GhuriSettings {
  SECRET_KEY: string
  DEBUG?: boolean
  ALLOWED_HOSTS?: string[]
  INSTALLED_APPS: Array<AppConfigClass | AppConfig>
  MIDDLEWARE?: MiddlewareLike[]
  ROOT_URLCONF: UrlPatternsLike
  APPEND_SLASH?: boolean
  TIME_ZONE?: string
  USE_TZ?: boolean
  CACHES?: Record<string, unknown>
  CSRF_TRUSTED_ORIGINS?: string[]
  CORS?: { allowOrigins: string[] | '*'; allowCredentials?: boolean } | false
  [key: string]: unknown
}

export interface SettingsFactory {
  (env: Env): GhuriSettings
  readonly __ghuriSettings: true
}

const DEFAULTS: Partial<GhuriSettings> = {
  DEBUG: false,
  ALLOWED_HOSTS: ['*'],
  MIDDLEWARE: [],
  APPEND_SLASH: true,
  TIME_ZONE: 'UTC',
  USE_TZ: true,
  CSRF_TRUSTED_ORIGINS: [],
  CORS: false,
}

/** Define project settings as a function of the runtime environment (Worker bindings / process.env). */
export function defineSettings(fn: (env: Env) => GhuriSettings): SettingsFactory {
  const cache = new WeakMap<object, GhuriSettings>()
  const factory = ((env: Env) => {
    const key = env ?? {}
    let resolved = cache.get(key)
    if (!resolved) {
      resolved = { ...DEFAULTS, ...fn(env ?? {}) } as GhuriSettings
      validateSettings(resolved)
      cache.set(key, resolved)
    }
    return resolved
  }) as SettingsFactory
  Object.defineProperty(factory, '__ghuriSettings', { value: true })
  return factory
}

export function isSettingsFactory(v: unknown): v is SettingsFactory {
  return typeof v === 'function' && (v as any).__ghuriSettings === true
}

function validateSettings(s: GhuriSettings): void {
  if (!s.SECRET_KEY && !s.DEBUG) {
    throw new ImproperlyConfigured('The SECRET_KEY setting must not be empty (set it in .dev.vars / wrangler secrets).')
  }
  if (!Array.isArray(s.INSTALLED_APPS)) throw new ImproperlyConfigured('INSTALLED_APPS must be an array.')
  if (!Array.isArray(s.ROOT_URLCONF)) throw new ImproperlyConfigured('ROOT_URLCONF must be an array of url patterns.')
}

/** Settings for the current request / run. */
export function getSettings(): GhuriSettings {
  return getContext().settings
}

/** Read one setting with a default, e.g. `setting('REST_FRAMEWORK', {})`. */
export function setting<T>(name: string, fallback: T): T {
  const v = getSettings()[name]
  return (v === undefined ? fallback : v) as T
}
