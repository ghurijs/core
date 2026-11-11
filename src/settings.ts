import type { MiddlewareHandler } from 'hono'
import type { AppConfig, AppConfigClass } from './apps'
import type { CacheConfig } from './cache'
import { type Env, getContext } from './context'
import { ImproperlyConfigured } from './errors'
import type { CorsOptions, Middleware } from './middleware'
import type { UrlPatterns } from './urls'

/** What `ROOT_URLCONF` accepts (see `path()` / `include()` in urls.ts). */
export type UrlPatternsLike = UrlPatterns
/** What `MIDDLEWARE` accepts: a Middleware class, a configured Middleware instance, or a plain Hono middleware. */
export type MiddlewareLike =
  | (new () => { handle(c: any, next: () => Promise<void>): Promise<Response | void> })
  | Middleware
  | MiddlewareHandler

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
  CACHES?: Record<string, CacheConfig>
  CSRF_TRUSTED_ORIGINS?: string[]
  CORS?: CorsOptions | false
  /** Paths whose errors are always rendered as JSON (default `['/api']`). */
  API_PATH_PREFIXES?: string[]
  // CSRF (Django names and defaults)
  CSRF_COOKIE_NAME?: string
  CSRF_HEADER_NAME?: string
  CSRF_COOKIE_AGE?: number | null
  CSRF_COOKIE_DOMAIN?: string
  CSRF_COOKIE_PATH?: string
  CSRF_COOKIE_SECURE?: boolean
  CSRF_COOKIE_HTTPONLY?: boolean
  CSRF_COOKIE_SAMESITE?: 'Lax' | 'Strict' | 'None' | false
  // Security (SecurityMiddleware / XFrameOptionsMiddleware / CommonMiddleware)
  SECURE_PROXY_SSL_HEADER?: [string, string]
  USE_X_FORWARDED_HOST?: boolean
  SECURE_SSL_REDIRECT?: boolean
  SECURE_SSL_HOST?: string
  SECURE_REDIRECT_EXEMPT?: string[]
  SECURE_HSTS_SECONDS?: number
  SECURE_HSTS_INCLUDE_SUBDOMAINS?: boolean
  SECURE_HSTS_PRELOAD?: boolean
  SECURE_CONTENT_TYPE_NOSNIFF?: boolean
  SECURE_REFERRER_POLICY?: string | string[] | false
  SECURE_CROSS_ORIGIN_OPENER_POLICY?: string | false
  X_FRAME_OPTIONS?: string | false
  PREPEND_WWW?: boolean
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
    throw new ImproperlyConfigured(
      'The SECRET_KEY setting must not be empty (set it in .dev.vars / wrangler secrets).',
    )
  }
  if (!Array.isArray(s.INSTALLED_APPS)) throw new ImproperlyConfigured('INSTALLED_APPS must be an array.')
  if (!Array.isArray(s.ROOT_URLCONF))
    throw new ImproperlyConfigured('ROOT_URLCONF must be an array of url patterns.')
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
