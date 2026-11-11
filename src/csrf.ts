import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { matchedRoutes } from 'hono/route'
import { PermissionDenied } from './errors'
import { settingsFor } from './exceptions'
import type { GhuriSettings } from './settings'
import { CSRF_EXEMPT_MARKER, getResolver, type ViewFunction } from './urls'

// Django-compatible token format: a 32-char secret stored in the cookie, 64-char masked tokens in forms.
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const CSRF_SECRET_LENGTH = 32
export const CSRF_TOKEN_LENGTH = 2 * CSRF_SECRET_LENGTH
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

/** 403 raised when CSRF verification fails. `reason` says why. */
export class CsrfFailure extends PermissionDenied {
  constructor(readonly reason: string) {
    super(`CSRF verification failed. Request aborted. ${reason}`)
  }
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  // 62 chars: reject bytes >= 248 to avoid modulo bias
  for (let i = 0; out.length < length; i++) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes)
      i = 0
    }
    if (bytes[i] < 248) out += CHARS[bytes[i] % 62]
  }
  return out
}

/** A new random CSRF secret (what the cookie stores). */
export function generateCsrfSecret(): string {
  return randomString(CSRF_SECRET_LENGTH)
}

export function maskCsrfSecret(secret: string): string {
  const mask = randomString(CSRF_SECRET_LENGTH)
  let cipher = ''
  for (let i = 0; i < CSRF_SECRET_LENGTH; i++) {
    cipher += CHARS[(CHARS.indexOf(secret[i]) + CHARS.indexOf(mask[i])) % 62]
  }
  return mask + cipher
}

export function unmaskCsrfToken(token: string): string {
  const mask = token.slice(0, CSRF_SECRET_LENGTH)
  const cipher = token.slice(CSRF_SECRET_LENGTH)
  let secret = ''
  for (let i = 0; i < CSRF_SECRET_LENGTH; i++) {
    secret += CHARS[(CHARS.indexOf(cipher[i]) - CHARS.indexOf(mask[i]) + 62) % 62]
  }
  return secret
}

function wellFormed(token: string | undefined): token is string {
  return (
    !!token &&
    (token.length === CSRF_SECRET_LENGTH || token.length === CSRF_TOKEN_LENGTH) &&
    /^[a-zA-Z0-9]+$/.test(token)
  )
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface CsrfState {
  secret?: string
  /** The secret must be (re)sent in a Set-Cookie header. */
  needsUpdate: boolean
}

const STATES = new WeakMap<Context, CsrfState>()

function csrfSettings(c: Context) {
  const s = (settingsFor(c) ?? {}) as GhuriSettings
  return {
    cookieName: (s.CSRF_COOKIE_NAME as string | undefined) ?? 'csrftoken',
    headerName: (s.CSRF_HEADER_NAME as string | undefined) ?? 'X-CSRFToken',
    cookieAge: (s.CSRF_COOKIE_AGE as number | null | undefined) ?? 31449600,
    cookieDomain: s.CSRF_COOKIE_DOMAIN as string | undefined,
    cookiePath: (s.CSRF_COOKIE_PATH as string | undefined) ?? '/',
    cookieSecure: !!s.CSRF_COOKIE_SECURE,
    cookieHttpOnly: !!s.CSRF_COOKIE_HTTPONLY,
    cookieSameSite: (s.CSRF_COOKIE_SAMESITE as 'Lax' | 'Strict' | 'None' | false | undefined) ?? 'Lax',
    trustedOrigins: s.CSRF_TRUSTED_ORIGINS ?? [],
  }
}

function state(c: Context): CsrfState {
  let st = STATES.get(c)
  if (!st) {
    const raw = getCookie(c, csrfSettings(c).cookieName)
    let secret: string | undefined
    if (wellFormed(raw)) secret = raw.length === CSRF_TOKEN_LENGTH ? unmaskCsrfToken(raw) : raw
    st = { secret, needsUpdate: false }
    STATES.set(c, st)
  }
  return st
}

/**
 * The CSRF token for forms/JS (`<input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken(c)} />`).
 * A new masked value is returned each call; `CsrfMiddleware` sends the cookie when it was just created.
 */
export function getCsrfToken(c: Context): string {
  const st = state(c)
  if (!st.secret) {
    st.secret = generateCsrfSecret()
    st.needsUpdate = true
  }
  return maskCsrfSecret(st.secret)
}

/** Change the CSRF secret (call on login, like Django's `rotate_token`). */
export function rotateCsrfToken(c: Context): void {
  const st = state(c)
  st.secret = generateCsrfSecret()
  st.needsUpdate = true
}

/** Mark a view (or a mounted Hono app) as exempt from `CsrfMiddleware`. */
export function csrfExempt<T extends object>(view: T): T {
  ;(view as any)[CSRF_EXEMPT_MARKER] = true
  return view
}

/** Make sure the CSRF cookie is set on this view's response (Django's `ensure_csrf_cookie`). */
export function ensureCsrfCookie(view: ViewFunction): ViewFunction {
  const wrapped: ViewFunction = (c) => {
    getCsrfToken(c)
    return view(c)
  }
  if ((view as any)[CSRF_EXEMPT_MARKER]) (wrapped as any)[CSRF_EXEMPT_MARKER] = true
  return wrapped
}

/** Is the request's view exempt from CSRF checks? */
export function isCsrfExempt(c: Context): boolean {
  try {
    for (const r of matchedRoutes(c)) if ((r.handler as any)?.[CSRF_EXEMPT_MARKER]) return true
  } catch {
    // no route information
  }
  const settings = settingsFor(c)
  if (!settings) return false
  try {
    const m = getResolver(settings.ROOT_URLCONF as any).match(c.req.path, c.req.method)
    if (!m) return false
    return !!((m.view as any)?.[CSRF_EXEMPT_MARKER] || (m.app as any)?.[CSRF_EXEMPT_MARKER])
  } catch {
    return false
  }
}

/** `https` request? Honors `SECURE_PROXY_SSL_HEADER = ['X-Forwarded-Proto', 'https']`. */
export function isSecure(c: Context): boolean {
  const s = settingsFor(c)
  const proxy = s?.SECURE_PROXY_SSL_HEADER as [string, string] | undefined
  if (proxy) {
    const v = c.req.header(proxy[0])
    if (v !== undefined) return v.split(',')[0].trim() === proxy[1]
  }
  return new URL(c.req.url).protocol === 'https:'
}

/** Request host (with port), honoring `USE_X_FORWARDED_HOST`. */
export function getHost(c: Context): string {
  const s = settingsFor(c)
  if (s?.USE_X_FORWARDED_HOST) {
    const fwd = c.req.header('x-forwarded-host')
    if (fwd) return fwd.split(',')[0].trim()
  }
  return c.req.header('host') ?? new URL(c.req.url).host
}

function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true
  const m = /^([a-z][a-z0-9+.-]*):\/\/\*\.(.+)$/i.exec(pattern)
  if (!m) return false
  try {
    const u = new URL(origin)
    return u.protocol === `${m[1].toLowerCase()}:` && (u.host === m[2] || u.host.endsWith(`.${m[2]}`))
  } catch {
    return false
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p)
  if (p.startsWith('*.')) return h.endsWith(p.slice(1))
  return h === p
}

/**
 * Run the CSRF checks for an unsafe request. Returns the failure reason, or `null` when the request passes.
 * Used by `CsrfMiddleware` and by REST session authentication.
 */
export async function checkCsrf(c: Context): Promise<string | null> {
  const cfg = csrfSettings(c)
  const secure = isSecure(c)
  const host = getHost(c)
  const origin = c.req.header('origin')
  if (origin !== undefined) {
    const good = `${secure ? 'https' : 'http'}://${host}`
    if (origin === 'null' || !(origin === good || cfg.trustedOrigins.some((t) => originMatches(origin, t)))) {
      return `Origin checking failed - ${origin} does not match any trusted origins.`
    }
  } else if (secure) {
    const referer = c.req.header('referer')
    if (!referer) return 'Referer checking failed - no Referer.'
    let ref: URL
    try {
      ref = new URL(referer)
    } catch {
      return 'Referer checking failed - Referer is malformed.'
    }
    if (ref.protocol !== 'https:')
      return 'Referer checking failed - Referer is insecure while host is secure.'
    const trustedHosts = cfg.trustedOrigins.map((t) => t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))
    const goodHost = cfg.cookieDomain ? [cfg.cookieDomain] : [host]
    if (![...goodHost, ...trustedHosts].some((p) => hostMatches(ref.host, p))) {
      return `Referer checking failed - ${referer} does not match any trusted origins.`
    }
  }

  const st = state(c)
  if (!st.secret) return 'CSRF cookie not set.'

  let token = c.req.header(cfg.headerName)
  let source = `'${cfg.headerName}' header`
  if (!token && c.req.method === 'POST') {
    const ct = c.req.header('content-type') ?? ''
    if (ct.startsWith('application/x-www-form-urlencoded') || ct.startsWith('multipart/form-data')) {
      try {
        const body = await c.req.parseBody()
        const v = body.csrfmiddlewaretoken
        if (typeof v === 'string') token = v
      } catch {
        // unreadable body → token missing
      }
      source = 'POST'
    }
  }
  if (!token) return 'CSRF token missing.'
  if (token.length !== CSRF_SECRET_LENGTH && token.length !== CSRF_TOKEN_LENGTH) {
    return `CSRF token from ${source} has incorrect length.`
  }
  if (!/^[a-zA-Z0-9]+$/.test(token)) return `CSRF token from ${source} has invalid characters.`
  const secret = token.length === CSRF_TOKEN_LENGTH ? unmaskCsrfToken(token) : token
  if (!constantTimeEquals(secret, st.secret)) return `CSRF token from ${source} incorrect.`
  return null
}

/** Throw `CsrfFailure` (403) unless the request passes the CSRF checks. Safe methods always pass. */
export async function enforceCsrf(c: Context): Promise<void> {
  if (SAFE_METHODS.has(c.req.method)) return
  const reason = await checkCsrf(c)
  if (reason) throw new CsrfFailure(reason)
}

/** Send the CSRF cookie if the token was created or rotated during this request. */
export function setCsrfCookieIfNeeded(c: Context): void {
  const st = STATES.get(c)
  if (!st?.needsUpdate || !st.secret) return
  const cfg = csrfSettings(c)
  setCookie(c, cfg.cookieName, st.secret, {
    path: cfg.cookiePath,
    domain: cfg.cookieDomain,
    maxAge: cfg.cookieAge ?? undefined,
    secure: cfg.cookieSecure,
    httpOnly: cfg.cookieHttpOnly,
    sameSite: cfg.cookieSameSite === false ? undefined : cfg.cookieSameSite,
  })
  st.needsUpdate = false
}

export { hostMatches, SAFE_METHODS as CSRF_SAFE_METHODS }
