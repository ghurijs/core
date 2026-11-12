import type { Context, MiddlewareHandler, Next } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { isXFrameOptionsExempt } from './clickjacking'
import {
  CSRF_SAFE_METHODS,
  CsrfFailure,
  checkCsrf,
  getHost,
  hostMatches,
  isCsrfExempt,
  isSecure,
  setCsrfCookieIfNeeded,
} from './csrf'
import { DisallowedHost } from './errors'
import { appendSlashRedirect, settingsFor } from './exceptions'
import type { GhuriSettings } from './settings'

/**
 * Django-style middleware: wraps the rest of the chain.
 *
 * ```ts
 * class TimingMiddleware extends Middleware {
 *   async handle(c: Context, next: Next) {
 *     const t = Date.now()
 *     await next()
 *     c.header('Server-Timing', `app;dur=${Date.now() - t}`)
 *   }
 * }
 * ```
 * Return a Response (before or after `next()`) to replace the response.
 */
export abstract class Middleware {
  abstract handle(c: Context, next: Next): Promise<Response | void>
}

export type MiddlewareClass = new () => Middleware

/** What `MIDDLEWARE` accepts: a Middleware class, an instance (for options), or a plain Hono middleware. */
export type MiddlewareEntry = MiddlewareClass | Middleware | MiddlewareHandler

function isMiddlewareClass(v: unknown): v is MiddlewareClass {
  return typeof v === 'function' && typeof (v as any).prototype?.handle === 'function'
}

/** Convert a `MIDDLEWARE` entry into a Hono middleware handler. */
export function toHonoMiddleware(entry: MiddlewareEntry): MiddlewareHandler {
  let instance: Middleware | undefined
  if (isMiddlewareClass(entry)) instance = new entry()
  else if (entry && typeof entry === 'object' && typeof (entry as Middleware).handle === 'function')
    instance = entry as Middleware
  else if (typeof entry === 'function') return entry as MiddlewareHandler
  if (!instance) throw new TypeError(`Invalid MIDDLEWARE entry: ${String(entry)}`)
  const mw = instance
  const handler: MiddlewareHandler = async (c, next) => {
    let called = false
    const res = await mw.handle(c, async () => {
      called = true
      await next()
    })
    if (res instanceof Response && res !== c.res) {
      // Replace cleanly instead of merging the previous response's headers.
      if (called) c.res = undefined as any
      c.res = res
    }
  }
  Object.defineProperty(handler, 'name', { value: mw.constructor.name })
  return handler
}

function settings(c: Context): GhuriSettings {
  return (settingsFor(c) ?? {}) as GhuriSettings
}

function setIfMissing(c: Context, name: string, value: string): void {
  if (!c.res.headers.has(name)) c.header(name, value)
}

// ---------------------------------------------------------------------------------------------
// Host validation (ALLOWED_HOSTS)
// ---------------------------------------------------------------------------------------------

/** Django's ALLOWED_HOSTS matching: `'*'`, exact hosts, or `'.example.com'` (domain + subdomains). */
export function isAllowedHost(host: string, allowed: string[]): boolean {
  const domain = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  return allowed.some((p) => p === '*' || hostMatches(domain.replace(/\.$/, ''), p))
}

/** Throws `DisallowedHost` (400) when the Host header is not in ALLOWED_HOSTS. */
export function validateHost(c: Context): void {
  const s = settings(c)
  let allowed = s.ALLOWED_HOSTS ?? ['*']
  if (allowed.length === 0 && s.DEBUG) allowed = ['.localhost', '127.0.0.1', '[::1]']
  if (allowed.includes('*')) return
  const host = getHost(c)
  if (!isAllowedHost(host, allowed)) {
    const domain = host.replace(/:\d+$/, '')
    throw new DisallowedHost(
      `Invalid HTTP_HOST header: '${host}'. You may need to add '${domain}' to ALLOWED_HOSTS.`,
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------------------------

/**
 * Security headers (Django's SecurityMiddleware). Settings: `SECURE_SSL_REDIRECT`, `SECURE_SSL_HOST`,
 * `SECURE_REDIRECT_EXEMPT`, `SECURE_HSTS_SECONDS` (HSTS is sent on https only, when > 0),
 * `SECURE_HSTS_INCLUDE_SUBDOMAINS`, `SECURE_HSTS_PRELOAD`, `SECURE_CONTENT_TYPE_NOSNIFF` (default true),
 * `SECURE_REFERRER_POLICY` (default 'same-origin'), `SECURE_CROSS_ORIGIN_OPENER_POLICY` (default 'same-origin').
 */
export class SecurityMiddleware extends Middleware {
  async handle(c: Context, next: Next): Promise<Response | void> {
    const s = settings(c)
    const secure = isSecure(c)
    if (s.SECURE_SSL_REDIRECT && !secure) {
      const exempt = ((s.SECURE_REDIRECT_EXEMPT as string[] | undefined) ?? []).some((re) =>
        new RegExp(re).test(c.req.path.replace(/^\//, '')),
      )
      if (!exempt) {
        const url = new URL(c.req.url)
        const host = (s.SECURE_SSL_HOST as string | undefined) ?? getHost(c)
        return new Response(null, {
          status: 301,
          headers: { Location: `https://${host}${url.pathname}${url.search}` },
        })
      }
    }
    await next()
    const hsts = Number(s.SECURE_HSTS_SECONDS ?? 0)
    if (secure && hsts > 0) {
      let v = `max-age=${hsts}`
      if (s.SECURE_HSTS_INCLUDE_SUBDOMAINS) v += '; includeSubDomains'
      if (s.SECURE_HSTS_PRELOAD) v += '; preload'
      setIfMissing(c, 'Strict-Transport-Security', v)
    }
    if (s.SECURE_CONTENT_TYPE_NOSNIFF !== false) setIfMissing(c, 'X-Content-Type-Options', 'nosniff')
    const referrer = s.SECURE_REFERRER_POLICY === undefined ? 'same-origin' : s.SECURE_REFERRER_POLICY
    if (referrer)
      setIfMissing(c, 'Referrer-Policy', Array.isArray(referrer) ? referrer.join(',') : String(referrer))
    const coop =
      s.SECURE_CROSS_ORIGIN_OPENER_POLICY === undefined ? 'same-origin' : s.SECURE_CROSS_ORIGIN_OPENER_POLICY
    if (coop) setIfMissing(c, 'Cross-Origin-Opener-Policy', String(coop))
  }
}

/**
 * `X-Frame-Options` header (setting `X_FRAME_OPTIONS`, default 'DENY'). Responses that set it keep theirs;
 * views wrapped in `xframeOptionsExempt()` (or class views with `static xframeOptionsExempt = true`) get none.
 */
export class XFrameOptionsMiddleware extends Middleware {
  async handle(c: Context, next: Next): Promise<void> {
    await next()
    if (isXFrameOptionsExempt(c)) return
    const v = (settings(c).X_FRAME_OPTIONS as string | undefined) ?? 'DENY'
    if (v) setIfMissing(c, 'X-Frame-Options', v.toUpperCase())
  }
}

/**
 * Django's CommonMiddleware: rejects hosts not in `ALLOWED_HOSTS`, `PREPEND_WWW` redirects, and
 * `APPEND_SLASH` (301 from `/x` to `/x/` for GET/HEAD when only the slashed path matches).
 */
export class CommonMiddleware extends Middleware {
  async handle(c: Context, next: Next): Promise<Response | void> {
    validateHost(c)
    const s = settings(c)
    const host = getHost(c)
    if (s.PREPEND_WWW && host && !host.startsWith('www.')) {
      const url = new URL(c.req.url)
      return new Response(null, {
        status: 301,
        headers: { Location: `${url.protocol}//www.${host}${url.pathname}${url.search}` },
      })
    }
    await next()
    if (c.res.status === 404 && s.APPEND_SLASH !== false) {
      const redirect = appendSlashRedirect(c)
      if (redirect) return redirect
    }
  }
}

export interface CorsOptions {
  allowOrigins: string[] | '*'
  allowCredentials?: boolean
  allowMethods?: string[]
  allowHeaders?: string[]
  exposeHeaders?: string[]
  maxAge?: number
}

/**
 * CORS headers and preflight handling. Configure with the `CORS` setting
 * (`{ allowOrigins: ['https://app.example.com'], allowCredentials: true }`) or `new CorsMiddleware({...})`.
 */
export class CorsMiddleware extends Middleware {
  private cache = new WeakMap<object, MiddlewareHandler>()

  constructor(private readonly options?: CorsOptions) {
    super()
  }

  private handlerFor(opts: CorsOptions): MiddlewareHandler {
    let h = this.cache.get(opts)
    if (!h) {
      const all = opts.allowOrigins === '*'
      const list = all ? [] : (opts.allowOrigins as string[])
      h = cors({
        origin:
          all && !opts.allowCredentials
            ? '*'
            : (origin) => (all || list.includes(origin) || list.includes('*') ? origin : null),
        credentials: opts.allowCredentials,
        allowMethods: opts.allowMethods ?? ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
        allowHeaders: opts.allowHeaders ?? [],
        exposeHeaders: opts.exposeHeaders ?? [],
        maxAge: opts.maxAge ?? 86400,
      })
      this.cache.set(opts, h)
    }
    return h
  }

  async handle(c: Context, next: Next): Promise<Response | void> {
    const opts = this.options ?? (settings(c).CORS as CorsOptions | false | undefined)
    if (!opts) return next()
    const res = await this.handlerFor(opts)(c, next)
    return res instanceof Response ? res : undefined
  }
}

/**
 * Cross-site request forgery protection (Django's CsrfViewMiddleware). Unsafe requests (POST, PUT, PATCH,
 * DELETE) must send the `csrftoken` cookie's token in the `X-CSRFToken` header or the `csrfmiddlewaretoken`
 * form field, and pass Origin/Referer checks against the host and `CSRF_TRUSTED_ORIGINS`.
 * Exempt views with `csrfExempt(view)`; read the token with `getCsrfToken(c)`.
 */
export class CsrfMiddleware extends Middleware {
  async handle(c: Context, next: Next): Promise<void> {
    if (!CSRF_SAFE_METHODS.has(c.req.method) && !isCsrfExempt(c)) {
      const reason = await checkCsrf(c)
      if (reason) throw new CsrfFailure(reason)
    }
    await next()
    setCsrfCookieIfNeeded(c)
  }
}

const isWorkers = () => (globalThis as any).navigator?.userAgent === 'Cloudflare-Workers'

/**
 * Compress responses (gzip/deflate). A no-op on Cloudflare Workers, where the edge compresses for you.
 */
export class GZipMiddleware extends Middleware {
  private compressor: MiddlewareHandler | undefined

  async handle(c: Context, next: Next): Promise<void> {
    if (isWorkers() || typeof (globalThis as any).CompressionStream === 'undefined') return next()
    this.compressor ??= compress()
    await this.compressor(c, next)
  }
}
