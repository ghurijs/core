import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { tryGetContext } from './context'
import { Http404, HttpError, MethodNotAllowed, ObjectDoesNotExist, ValidationError } from './errors'
import type { GhuriSettings } from './settings'
import type { UrlResolver } from './urls'
import { getResolver, Resolver404, resolverMatch } from './urls'

// ---------------------------------------------------------------------------------------------
// Pluggable exception handlers (other packages map their own errors, e.g. rest's APIException)
// ---------------------------------------------------------------------------------------------

export type ExceptionHandler = (
  err: any,
  c: Context,
) => Response | undefined | null | void | Promise<Response | undefined | null | void>

type Matcher = ((err: unknown) => boolean) | (abstract new (...args: any[]) => unknown)

interface Registered {
  match: (err: unknown) => boolean
  handler: ExceptionHandler
}

const HANDLERS_KEY = Symbol.for('ghuri.core.exceptionHandlers')
const registered: Registered[] = ((globalThis as any)[HANDLERS_KEY] ??= [])

function isClass(m: Matcher): m is abstract new (...args: any[]) => unknown {
  if (typeof m !== 'function' || m.prototype === undefined) return false
  return (
    m === Error || m.prototype instanceof Error || /^class[\s{]/.test(Function.prototype.toString.call(m))
  )
}

/**
 * Map an error class (or predicate) to a response. Handlers registered later win. Return `undefined` to
 * fall through to the next handler / the default mapping.
 *
 * ```ts
 * registerExceptionHandler(APIException, (err, c) => c.json(err.detail, err.status))
 * ```
 */
export function registerExceptionHandler(matcher: Matcher, handler: ExceptionHandler): () => void {
  const entry: Registered = {
    match: isClass(matcher)
      ? (err) => err instanceof (matcher as any)
      : (matcher as (err: unknown) => boolean),
    handler,
  }
  registered.unshift(entry)
  return () => {
    const i = registered.indexOf(entry)
    if (i >= 0) registered.splice(i, 1)
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? (status >= 500 ? 'Server Error' : 'Error')
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Settings of the request (works even if the error happened outside the context scope). */
export function settingsFor(c?: Context): GhuriSettings | undefined {
  let fromHono: GhuriSettings | undefined
  try {
    fromHono = c?.get('ghuri')?.settings
  } catch {
    fromHono = undefined
  }
  return fromHono ?? tryGetContext()?.settings
}

/**
 * Should errors for this request be rendered as JSON? True for API paths (`/api…`), clients that
 * accept JSON but not HTML, JSON request bodies and XHR requests.
 */
export function wantsJson(c: Context): boolean {
  const accept = c.req.header('accept') ?? ''
  const settings = settingsFor(c)
  const prefixes = (settings?.API_PATH_PREFIXES as string[] | undefined) ?? ['/api']
  const path = c.req.path
  if (prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))) return true
  if (accept.includes('text/html')) return false
  if (accept.includes('application/json') || accept.includes('+json')) return true
  if ((c.req.header('content-type') ?? '').includes('application/json')) return true
  if (c.req.header('x-requested-with') === 'XMLHttpRequest') return true
  return false
}

const SENSITIVE = /API|KEY|PASS|SECRET|SIGNATURE|TOKEN|CREDENTIAL|PRIVATE/i

function repr(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  if (typeof value === 'function') return (value as any).name ? `<${(value as any).name}>` : '<function>'
  if (depth > 2) return Array.isArray(value) ? '[…]' : '{…}'
  if (Array.isArray(value))
    return `[${value
      .slice(0, 20)
      .map((v) => repr(v, depth + 1))
      .join(', ')}${value.length > 20 ? ', …' : ''}]`
  if (typeof value === 'object') {
    const ctor = (value as any).constructor?.name
    if (ctor && ctor !== 'Object') return `<${ctor}>`
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20)
    return `{ ${entries.map(([k, v]) => `${k}: ${SENSITIVE.test(k) ? '••••••' : repr(v, depth + 1)}`).join(', ')} }`
  }
  return String(value)
}

/** Settings with secrets masked (debug pages). */
export function cleansedSettings(settings: GhuriSettings | undefined): Array<[string, string]> {
  if (!settings) return []
  return Object.keys(settings)
    .sort()
    .map((k) => [k, SENSITIVE.test(k) ? '••••••••••••••••••••' : repr(settings[k])])
}

const PAGE_CSS = `
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328;background:#fff}
  header{padding:18px 24px;background:#ffc;border-bottom:1px solid #ddd} header.err{background:#fde8e8}
  h1{margin:0 0 4px;font-size:22px;font-weight:600} h2{font-size:16px;margin:24px 0 8px}
  main{padding:8px 24px 32px} code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;white-space:pre-wrap}
  table{border-collapse:collapse;width:100%} td,th{text-align:left;vertical-align:top;padding:4px 8px;border-bottom:1px solid #eee}
  th{width:220px;font-weight:600;color:#555} .muted{color:#666} ol li{margin:2px 0} .name{color:#666;margin-left:8px}
  @media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3} header{background:#3a3200;border-color:#333}
  header.err{background:#3d1416} pre{background:#161b22} td,th{border-color:#222} th,.muted,.name{color:#9aa4ae}}
`

function page(title: string, header: string, body: string, error = false): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body><header${error ? ' class="err"' : ''}>${header}</header><main>${body}</main></body></html>`
}

function simplePage(status: number, message: string): string {
  const title = `${status} ${statusText(status)}`
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#1f2328}h1{font-size:28px;font-weight:600;margin:0 0 8px}p{color:#555}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}p{color:#9aa4ae}}</style></head><body><h1>${escapeHtml(title)}</h1>${message ? `<p>${escapeHtml(message)}</p>` : ''}</body></html>`
}

function requestTable(c: Context): string {
  const rows: Array<[string, string]> = [
    ['Request Method', c.req.method],
    ['Request URL', c.req.url],
  ]
  const match = resolverMatch(c)
  if (match)
    rows.push(['Matched route', `${match.route}${match.viewName ? ` [name='${match.viewName}']` : ''}`])
  for (const [k, v] of c.req.raw.headers) {
    rows.push([`Header ${k}`, /cookie|authorization/i.test(k) ? '••••••••' : v])
  }
  return `<table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><code>${escapeHtml(v)}</code></td></tr>`).join('')}</table>`
}

function technical500(err: unknown, c: Context, settings: GhuriSettings | undefined): string {
  const e = err instanceof Error ? err : new Error(String(err))
  const causes: string[] = []
  let cause = (e as any).cause
  while (cause && causes.length < 5) {
    causes.push(cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause))
    cause = cause instanceof Error ? (cause as any).cause : undefined
  }
  const header = `<h1>${escapeHtml(e.name)} at ${escapeHtml(c.req.path)}</h1><div class="muted">${escapeHtml(e.message)}</div>`
  const body = `
    <h2>Traceback</h2><pre>${escapeHtml(e.stack ?? String(e))}</pre>
    ${causes.map((s) => `<h2>Caused by</h2><pre>${escapeHtml(s)}</pre>`).join('')}
    <h2>Request</h2>${requestTable(c)}
    <h2>Settings</h2><table>${cleansedSettings(settings)
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><code>${escapeHtml(v)}</code></td></tr>`)
      .join('')}</table>
    <p class="muted">You're seeing this error because you have <code>DEBUG = true</code> in your Ghuri settings. Change that to <code>false</code>, and Ghuri will display a standard page.</p>`
  return page(`${e.name} at ${c.req.path}`, header, body, true)
}

function patternList(urlconf: UrlResolver | undefined): string {
  if (!urlconf) return ''
  return `<ol>${urlconf.routes
    .map(
      (r) =>
        `<li><code>${escapeHtml(r.pattern || '(empty path)')}${r.kind === 'app' ? ' [Hono app]' : ''}</code>${
          r.fullName ? `<span class="name">[name='${escapeHtml(r.fullName)}']</span>` : ''
        }${r.methods ? `<span class="name">${escapeHtml(r.methods.join(', '))}</span>` : ''}</li>`,
    )
    .join('')}</ol>`
}

function technical404(
  c: Context,
  message: string,
  urlconf: UrlResolver | undefined,
  raisedInView: boolean,
): string {
  const path = c.req.path.replace(/^\//, '')
  const header = `<h1>Page not found <span class="muted">(404)</span></h1><table><tr><th>Request Method:</th><td>${escapeHtml(
    c.req.method,
  )}</td></tr><tr><th>Request URL:</th><td>${escapeHtml(c.req.url)}</td></tr>${
    raisedInView
      ? `<tr><th>Raised by:</th><td>${escapeHtml(resolverMatch(c)?.viewName ?? resolverMatch(c)?.route ?? '')}</td></tr>`
      : ''
  }</table>`
  let body: string
  if (raisedInView) {
    body = `<p>${escapeHtml(message)}</p>`
  } else {
    body = `<p>Using the URLconf defined in <code>ROOT_URLCONF</code>, Ghuri tried these URL patterns, in this order:</p>${patternList(
      urlconf,
    )}<p>The current path, <code>${escapeHtml(path)}</code>, didn't match any of these.</p>`
    if (
      !c.req.path.endsWith('/') &&
      !['GET', 'HEAD'].includes(c.req.method) &&
      urlconf?.isValidPath(`${c.req.path}/`)
    ) {
      body += `<p><strong>Note:</strong> You called this URL via ${escapeHtml(c.req.method)}, but the URL doesn't end in a slash and you have APPEND_SLASH set. Ghuri can't redirect to the slash URL while maintaining ${escapeHtml(c.req.method)} data. Change your form/request to point to <code>${escapeHtml(c.req.path)}/</code> (note the trailing slash).</p>`
    }
  }
  body += `<p class="muted">You're seeing this error because you have <code>DEBUG = true</code> in your Ghuri settings. Change that to <code>false</code>, and Ghuri will display a standard 404 page.</p>`
  return page('Page not found', header, body)
}

function currentResolver(settings: GhuriSettings | undefined): UrlResolver | undefined {
  try {
    return settings ? getResolver(settings.ROOT_URLCONF as any) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------------------------

function errorBody(
  c: Context,
  status: number,
  payload: Record<string, unknown>,
  html: string,
  headers?: HeadersInit,
): Response {
  const res = wantsJson(c)
    ? new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
      })
    : new Response(html, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } })
  if (headers) for (const [k, v] of new Headers(headers)) res.headers.set(k, v)
  return res
}

/** Render a 404 for a path no pattern matched (DEBUG lists the URL patterns, like Django). */
export function notFoundResponse(
  c: Context,
  message = 'The requested resource was not found on this server.',
): Response {
  const settings = settingsFor(c)
  const debug = !!settings?.DEBUG
  const urlconf = debug ? currentResolver(settings) : undefined
  const payload: Record<string, unknown> = { detail: 'Not found.' }
  if (debug) {
    payload.path = c.req.path
    payload.tried =
      urlconf?.routes.map((r) => (r.fullName ? `${r.pattern} [name='${r.fullName}']` : r.pattern)) ?? []
  }
  return errorBody(
    c,
    404,
    payload,
    debug ? technical404(c, message, urlconf, false) : simplePage(404, message),
  )
}

/**
 * Turn any thrown value into a Response: registered handlers first, then `HttpError` subclasses,
 * `ValidationError` (400), `ObjectDoesNotExist` (404), Hono's `HTTPException`, and finally 500.
 */
export async function handleException(err: unknown, c: Context): Promise<Response> {
  if (err instanceof Response) return err
  for (const r of [...registered]) {
    if (!r.match(err)) continue
    const res = await r.handler(err, c)
    if (res instanceof Response) return res
  }
  const settings = settingsFor(c)
  const debug = !!settings?.DEBUG

  if (err instanceof HTTPException) {
    if ((err as any).res) return err.getResponse()
    const status = err.status
    if (status >= 500) console.error(err)
    return errorBody(
      c,
      status,
      { detail: err.message || statusText(status) },
      simplePage(status, err.message),
    )
  }
  if (err instanceof ValidationError) {
    const payload = {
      detail: err.messages.length === 1 && !err.hasFieldErrors ? err.messages[0] : 'Invalid input.',
      errors: err.toDict(),
    }
    const list = Object.entries(err.toDict())
      .map(([k, msgs]) => `${k === '__all__' ? '' : `${k}: `}${msgs.join(' ')}`)
      .join('; ')
    return errorBody(c, 400, payload, simplePage(400, list))
  }
  if (err instanceof Http404 || err instanceof ObjectDoesNotExist) {
    const message = err.message || 'Not found.'
    if (debug) {
      if (err instanceof Resolver404) return notFoundResponse(c, message)
      return errorBody(
        c,
        404,
        { detail: message, exception: err.name },
        technical404(c, message, currentResolver(settings), true),
      )
    }
    return errorBody(c, 404, { detail: err instanceof Http404 ? message : 'Not found.' }, simplePage(404, ''))
  }
  if (err instanceof MethodNotAllowed) {
    return errorBody(c, 405, { detail: err.message }, simplePage(405, err.message), {
      Allow: err.allowed.join(', '),
    })
  }
  if (err instanceof HttpError) {
    const status = err.status
    if (status >= 500) console.error(err)
    return errorBody(
      c,
      status,
      { detail: err.message },
      simplePage(status, status >= 500 && !debug ? '' : err.message),
    )
  }

  console.error(err)
  if (debug) {
    const e = err instanceof Error ? err : new Error(String(err))
    return errorBody(
      c,
      500,
      { detail: e.message, exception: e.name, stack: (e.stack ?? '').split('\n').map((l) => l.trim()) },
      technical500(err, c, settings),
    )
  }
  return errorBody(c, 500, { detail: 'Internal Server Error' }, simplePage(500, ''))
}

/** Hono `onError` handler. */
export const errorHandler = (err: Error, c: Context): Promise<Response> => handleException(err, c)

/** Redirect `/x` → `/x/` (301) when APPEND_SLASH applies (GET/HEAD, path unmatched, slashed path matches). */
export function appendSlashRedirect(c: Context, urlconf?: UrlResolver): Response | null {
  const path = c.req.path
  if (path.endsWith('/')) return null
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return null
  const resolver = urlconf ?? currentResolver(settingsFor(c))
  if (!resolver) return null
  if (resolver.isValidPath(path) || !resolver.isValidPath(`${path}/`)) return null
  const url = new URL(c.req.url)
  return new Response(null, { status: 301, headers: { Location: `${path}/${url.search}` } })
}

/** Hono `notFound` handler: APPEND_SLASH, 405 for method-restricted routes, then 404. */
export function notFoundHandler(urlconf?: UrlResolver) {
  return (c: Context): Response | Promise<Response> => {
    const settings = settingsFor(c)
    const resolver = urlconf ?? currentResolver(settings)
    if (settings?.APPEND_SLASH !== false) {
      const redirect = appendSlashRedirect(c, resolver)
      if (redirect) return redirect
    }
    if (resolver) {
      const matches = resolver.matchAll(c.req.path).filter((m) => m.compiled.kind === 'view')
      if (matches.length && matches.every((m) => m.methods)) {
        const allowed = new Set<string>()
        for (const m of matches) for (const x of m.methods!) allowed.add(x)
        if (allowed.has('GET')) allowed.add('HEAD')
        return handleException(new MethodNotAllowed(c.req.method, [...allowed]), c)
      }
    }
    return notFoundResponse(c)
  }
}
