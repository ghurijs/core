import type { Context, Hono, Next } from 'hono'
import { tryGetContext } from './context'
import { GhuriError, Http404, ImproperlyConfigured } from './errors'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** A view is a plain Hono handler that receives the request context and returns a Response. */
export type ViewFunction = (c: Context) => Response | Promise<Response>

/** Any Hono application (escape hatch: `path('legacy/', someHonoApp)`). */
export type HonoApp = Hono<any, any, any>

/** One URL pattern. Build it with `path()` / `rePath()` rather than by hand. */
export interface UrlEntry {
  /** Django-style route (`'posts/<int:id>/'`) or, when `regex` is true, a regular expression. */
  route: string
  view?: ViewFunction
  /** A mounted Hono application. */
  app?: HonoApp
  /** Included patterns (`include()`, or `path('admin/', admin.site.urls)`). */
  children?: UrlPatterns
  name?: string
  namespace?: string
  /** Restrict the route to these HTTP methods (other methods get 405). */
  methods?: string[]
  /** `true` for `rePath()` entries. */
  regex?: boolean
  /** Extra keyword arguments merged into `kwargs(c)` (Django's `path(..., kwargs={...})`). */
  kwargs?: Record<string, unknown>
}

/** A list of URL patterns. May carry an `appName` (Django's `app_name`) used as default namespace. */
export type UrlPatterns = UrlEntry[] & { appName?: string }

const INCLUDE = Symbol.for('ghuri.urls.include')

/** Result of `include()`. */
export interface UrlInclude {
  readonly [INCLUDE]: true
  patterns: UrlPatterns
  namespace?: string
}

/** Something that can be included: patterns, an `include()` result, or a urls module. */
export type Includable = UrlPatterns | UrlInclude | { urlpatterns: UrlPatterns; appName?: string }

/** Anything with a static `asView()` (class-based views). */
export interface ViewClassLike {
  asView(initkwargs?: any): ViewFunction
}

export type PathTarget = ViewFunction | ViewClassLike | HonoApp | Includable

export interface PathOptions {
  name?: string
  methods?: string[]
  kwargs?: Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** `reverse()` could not build a URL (Django: NoReverseMatch). */
export class NoReverseMatch extends GhuriError {}

/** `resolve()` found no pattern (Django: Resolver404). */
export class Resolver404 extends Http404 {}

// ---------------------------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------------------------

export interface Converter<T = unknown> {
  /** Regular expression (JS syntax, no anchors) a value must match. */
  regex: string
  /** URL text → JS value (used by `kwargs(c)`). */
  toJs(value: string): T
  /** JS value → URL text (used by `reverse()`). */
  toUrl(value: unknown): string
}

const str: Converter<string> = { regex: '[^/]+', toJs: (v) => v, toUrl: (v) => String(v) }

const CONVERTERS_KEY = Symbol.for('ghuri.core.urlConverters')
/** Registered path converters, by name. */
export const converters: Record<string, Converter> = ((globalThis as any)[CONVERTERS_KEY] ??= {
  str,
  int: { regex: '[0-9]+', toJs: (v: string) => Number.parseInt(v, 10), toUrl: (v: unknown) => String(v) },
  slug: { regex: '[-a-zA-Z0-9_]+', toJs: (v: string) => v, toUrl: (v: unknown) => String(v) },
  uuid: {
    regex: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    toJs: (v: string) => v,
    toUrl: (v: unknown) => String(v),
  },
  path: { regex: '.+', toJs: (v: string) => v, toUrl: (v: unknown) => String(v) },
} satisfies Record<string, Converter>)

/** Django's `register_converter`: `registerConverter('year', { regex: '[0-9]{4}', toJs: Number, toUrl: String })`. */
export function registerConverter<T>(name: string, converter: Converter<T>): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new ImproperlyConfigured(`Invalid converter name '${name}'.`)
  converters[name] = converter as Converter
}

// ---------------------------------------------------------------------------------------------
// path() / rePath() / include()
// ---------------------------------------------------------------------------------------------

function isInclude(v: unknown): v is UrlInclude {
  return typeof v === 'object' && v !== null && (v as any)[INCLUDE] === true
}

function isHonoApp(v: unknown): v is HonoApp {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as any).fetch === 'function' &&
    Array.isArray((v as any).routes) &&
    typeof (v as any).route === 'function'
  )
}

function isViewClass(v: unknown): v is ViewClassLike {
  return typeof v === 'function' && typeof (v as any).asView === 'function'
}

/**
 * Include other URL patterns, optionally under a namespace:
 * `path('blog/', include(blogUrls, { namespace: 'blog' }))`.
 * Patterns carrying `appName` (or a module exporting `urlpatterns` + `appName`) are namespaced automatically.
 */
export function include(target: Includable, opts: { namespace?: string } = {}): UrlInclude {
  if (isInclude(target)) {
    return { [INCLUDE]: true, patterns: target.patterns, namespace: opts.namespace ?? target.namespace }
  }
  let patterns: UrlPatterns
  let appName: string | undefined
  if (Array.isArray(target)) {
    patterns = target
    appName = target.appName
  } else if (target && Array.isArray((target as any).urlpatterns)) {
    patterns = (target as any).urlpatterns
    appName = (target as any).appName ?? (target as any).urlpatterns.appName
  } else {
    throw new ImproperlyConfigured(
      'include() expects an array of url patterns or a module exporting `urlpatterns`.',
    )
  }
  return { [INCLUDE]: true, patterns, namespace: opts.namespace ?? appName }
}

function makeEntry(route: string, target: PathTarget, opts: PathOptions, regex: boolean): UrlEntry {
  if (typeof route !== 'string')
    throw new ImproperlyConfigured(`path() route must be a string, got ${typeof route}.`)
  const base: UrlEntry = { route, regex: regex || undefined }
  if (opts.name) base.name = opts.name
  if (opts.methods) base.methods = opts.methods.map((m) => m.toUpperCase())
  if (opts.kwargs) base.kwargs = opts.kwargs
  if (isInclude(target)) return { ...base, children: target.patterns, namespace: target.namespace }
  if (Array.isArray(target) || (target && Array.isArray((target as any).urlpatterns))) {
    const inc = include(target as Includable)
    return { ...base, children: inc.patterns, namespace: inc.namespace }
  }
  if (isHonoApp(target)) return { ...base, app: target }
  if (isViewClass(target)) return { ...base, view: target.asView() }
  if (typeof target === 'function') return { ...base, view: target as ViewFunction }
  throw new ImproperlyConfigured(
    `path('${route}', …): the target must be a view function, a View class, a Hono app or include(...).`,
  )
}

/** Django's `path()`: `path('posts/<int:id>/', postDetail, { name: 'post-detail' })`. */
export function path(route: string, target: PathTarget, opts: PathOptions = {}): UrlEntry {
  return makeEntry(route, target, opts, false)
}

/**
 * Django's `re_path()`. Named groups become parameters; both `(?<name>…)` and Python's `(?P<name>…)` work:
 * `rePath('^archive/(?<year>[0-9]{4})/$', archive)`.
 */
export function rePath(regex: string, target: PathTarget, opts: PathOptions = {}): UrlEntry {
  return makeEntry(regex, target, opts, true)
}

/** Build url patterns with an `appName` (Django's `app_name = 'blog'`). */
export function urlpatterns(appName: string | undefined, patterns: UrlEntry[]): UrlPatterns {
  const out = [...patterns] as UrlPatterns
  if (appName) out.appName = appName
  return out
}

// ---------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------

type Token = { lit: string } | { param: string; regex: string; converter: Converter }

interface Part {
  regex: boolean
  source: string
}

/** A flattened, compiled route. */
export interface CompiledRoute {
  kind: 'view' | 'app'
  /** Full human-readable route, e.g. `blog/<slug:slug>/`. */
  pattern: string
  /** Anchored regex matched against the path without its leading slash. */
  regex: RegExp
  /** Hono route path, or null when the route needs regex matching (rePath / complex segments). */
  honoPath: string | null
  params: Array<{ name: string; converter: Converter }>
  /** Reverse tokens, or null when the route cannot be reversed. */
  tokens: Token[] | null
  view?: ViewFunction
  app?: HonoApp
  name?: string
  namespaces: string[]
  /** Namespaced name (`'blog:post-detail'`). */
  fullName?: string
  methods?: string[]
  extraKwargs: Record<string, unknown>
}

/** What `resolve()` returns (Django's ResolverMatch). */
export interface ResolverMatch {
  route: string
  urlName?: string
  namespace: string
  namespaces: string[]
  /** `namespace:urlName`. */
  viewName?: string
  kwargs: Record<string, any>
  view?: ViewFunction
  app?: HonoApp
  methods?: string[]
  compiled: CompiledRoute
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function tokenizePath(route: string): Token[] {
  const tokens: Token[] = []
  const re = /<(?:([^<>:]+):)?([^<>]+)>/g
  let last = 0
  for (const m of route.matchAll(re)) {
    if (m.index! > last) tokens.push({ lit: route.slice(last, m.index) })
    const convName = m[1] ?? 'str'
    const name = m[2]
    if (!IDENT.test(name)) {
      throw new ImproperlyConfigured(
        `URL route '${route}' uses parameter name '${name}' which isn't a valid identifier.`,
      )
    }
    const converter = converters[convName]
    if (!converter) {
      throw new ImproperlyConfigured(`URL route '${route}' uses invalid converter '${convName}'.`)
    }
    tokens.push({ param: name, regex: converter.regex, converter })
    last = m.index! + m[0].length
  }
  if (last < route.length) tokens.push({ lit: route.slice(last) })
  if (/[<>]/.test(tokens.map((t) => ('lit' in t ? t.lit : '')).join(''))) {
    throw new ImproperlyConfigured(`URL route '${route}' has unmatched '<' or '>'.`)
  }
  return tokens
}

/** Find the index of the `)` closing the group that opens at `start` (which points at `(`). */
function closingParen(src: string, start: number): number {
  let depth = 0
  let inClass = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Python-style `(?P<name>` → JS `(?<name>`. */
function normalizeRegex(src: string): string {
  return src.replace(/\(\?P</g, '(?<')
}

/** Try to turn a simple regex (literal text + named groups) into tokens; null if it is not simple. */
function tokenizeRegex(src: string): Token[] | null {
  const tokens: Token[] = []
  let lit = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[i + 1]
      if (next !== undefined && /[^A-Za-z0-9]/.test(next)) {
        lit += next
        i += 2
        continue
      }
      return null
    }
    if (ch === '(') {
      const m = /^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i))
      if (!m) return null
      const end = closingParen(src, i)
      if (end < 0) return null
      if (lit) tokens.push({ lit })
      lit = ''
      const inner = src.slice(i + m[0].length, end)
      if (/\(\?<[A-Za-z_]/.test(inner)) return null
      tokens.push({ param: m[1], regex: inner, converter: str })
      i = end + 1
      continue
    }
    if ('.*+?[]{}|^$'.includes(ch)) return null
    lit += ch
    i++
  }
  if (lit) tokens.push({ lit })
  return tokens
}

/**
 * Make a converter regex safe for Hono's `:name{regex}` syntax: Hono's parser does not allow `{`/`}`
 * inside the pattern, so simple `X{n}` / `X{n,m}` quantifiers are expanded; capturing groups become
 * non-capturing. Returns null if the regex cannot be represented.
 */
function honoSafeRegex(regex: string): string | null {
  let out = ''
  let i = 0
  let lastAtom = ''
  while (i < regex.length) {
    const ch = regex[i]
    let atom: string
    if (ch === '\\') {
      atom = regex.slice(i, i + 2)
      i += 2
    } else if (ch === '[') {
      let j = i + 1
      if (regex[j] === '^') j++
      if (regex[j] === ']') j++
      while (j < regex.length && regex[j] !== ']') j += regex[j] === '\\' ? 2 : 1
      if (j >= regex.length) return null
      atom = regex.slice(i, j + 1)
      i = j + 1
    } else if (ch === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(regex.slice(i))
      if (!m || !lastAtom) return null
      const min = Number(m[1])
      const hasComma = m[2] === ','
      const max = m[3] ? Number(m[3]) : undefined
      if (min > 64 || (max ?? 0) > 64) return null
      // remove the atom we already emitted, then expand
      out = out.slice(0, out.length - lastAtom.length)
      let expanded = lastAtom.repeat(min)
      if (hasComma && max === undefined) expanded += `${lastAtom}*`
      else if (hasComma && max !== undefined) expanded += `${lastAtom}?`.repeat(Math.max(0, max - min))
      out += expanded
      i += m[0].length
      lastAtom = ''
      continue
    } else if (ch === '(' || ch === ')') {
      // Groups make quantifier expansion ambiguous; only allow them when no `{` follows anywhere.
      if (regex.includes('{') || regex.includes('}')) return null
      atom = ch === '(' && regex[i + 1] !== '?' ? '(?:' : ch
      i++
      out += atom
      lastAtom = ''
      continue
    } else {
      atom = ch
      i++
    }
    if (atom === '}') return null
    out += atom
    lastAtom = '*+?|'.includes(atom) ? '' : atom
  }
  if (/[{}]/.test(out)) return null
  return out
}

/** Hono path for tokens, or null when Hono can't express it. */
function tokensToHono(tokens: Token[]): string | null {
  // Join into segments split on '/'.
  const segments: Token[][] = [[]]
  for (const t of tokens) {
    if ('lit' in t) {
      const pieces = t.lit.split('/')
      pieces.forEach((p, idx) => {
        if (idx > 0) segments.push([])
        if (p) segments[segments.length - 1].push({ lit: p })
      })
    } else {
      segments[segments.length - 1].push(t)
    }
  }
  const out: string[] = []
  for (const seg of segments) {
    if (seg.length === 0) {
      out.push('')
      continue
    }
    if (seg.length > 1) return null
    const t = seg[0]
    if ('lit' in t) {
      if (/[:*{}?()]/.test(t.lit)) return null
      out.push(t.lit)
    } else {
      // A param that can span slashes is only representable as the last segment.
      if (t.regex === '[^/]+') {
        out.push(`:${t.param}`)
      } else {
        const safe = honoSafeRegex(t.regex)
        if (safe === null) return null
        out.push(`:${t.param}{${safe.includes('|') ? `(?:${safe})` : safe}}`)
      }
    }
  }
  return `/${out.join('/')}`
}

function tokensToRegexSource(tokens: Token[]): string {
  return tokens.map((t) => ('lit' in t ? escapeRegex(t.lit) : `(?<${t.param}>${t.regex})`)).join('')
}

function stripAnchors(src: string, isLast: boolean): string {
  let s = src
  if (s.startsWith('^')) s = s.slice(1)
  if (isLast && s.endsWith('$') && !s.endsWith('\\$')) s = s.slice(0, -1)
  return s
}

interface FlattenState {
  parts: Part[]
  namespaces: string[]
  extraKwargs: Record<string, unknown>
}

function displayPart(p: Part, isLast: boolean): string {
  return p.regex ? stripAnchors(normalizeRegex(p.source), isLast) : p.source
}

function compileParts(
  parts: Part[],
  prefixOnly: boolean,
): {
  regex: RegExp
  honoPath: string | null
  params: Array<{ name: string; converter: Converter }>
  tokens: Token[] | null
  pattern: string
} {
  let tokens: Token[] | null = []
  let source = ''
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const isLast = i === parts.length - 1 && !prefixOnly
    if (p.regex) {
      const body = stripAnchors(normalizeRegex(p.source), isLast)
      const t = tokenizeRegex(body)
      if (t && tokens) tokens.push(...t)
      else tokens = null
      source += body
    } else {
      const t = tokenizePath(p.source)
      if (tokens) tokens.push(...t)
      source += tokensToRegexSource(t)
    }
  }
  const params: Array<{ name: string; converter: Converter }> = []
  if (tokens) {
    for (const t of tokens) if ('param' in t) params.push({ name: t.param, converter: t.converter })
  } else {
    for (const m of source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g))
      params.push({ name: m[1], converter: str })
  }
  const names = params.map((p) => p.name)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  const pattern = parts.map((p, i) => displayPart(p, i === parts.length - 1)).join('')
  if (dup) throw new ImproperlyConfigured(`URL pattern '${pattern}' uses parameter '${dup}' more than once.`)
  let regex: RegExp
  try {
    regex = new RegExp(`^${source}${prefixOnly ? '' : '$'}`)
  } catch (err) {
    throw new ImproperlyConfigured(
      `URL pattern '${pattern}' is not a valid regular expression: ${(err as Error).message}`,
    )
  }
  const honoPath = tokens ? tokensToHono(tokens) : null
  return { regex, honoPath, params, tokens, pattern }
}

function flatten(patterns: UrlPatterns, state: FlattenState, out: CompiledRoute[]): void {
  if (!Array.isArray(patterns)) throw new ImproperlyConfigured('URL patterns must be an array.')
  for (const entry of patterns) {
    if (!entry || typeof entry.route !== 'string') {
      throw new ImproperlyConfigured(
        `Invalid URL pattern ${String(entry)}; use path() / rePath() / include().`,
      )
    }
    const route = entry.regex ? entry.route : entry.route.replace(/^\/+/, '')
    const parts = [...state.parts, { regex: !!entry.regex, source: route }]
    const extraKwargs = { ...state.extraKwargs, ...entry.kwargs }
    if (entry.children) {
      const namespaces = entry.namespace ? [...state.namespaces, entry.namespace] : state.namespaces
      flatten(entry.children, { parts, namespaces, extraKwargs }, out)
      continue
    }
    const kind = entry.app ? 'app' : 'view'
    if (!entry.app && !entry.view) throw new ImproperlyConfigured(`URL pattern '${entry.route}' has no view.`)
    const compiled = compileParts(parts, kind === 'app')
    if (kind === 'app' && compiled.honoPath === null) {
      throw new ImproperlyConfigured(`Cannot mount a Hono app under the regex route '${compiled.pattern}'.`)
    }
    const fullName = entry.name ? [...state.namespaces, entry.name].join(':') : undefined
    out.push({
      kind,
      ...compiled,
      view: entry.view,
      app: entry.app,
      name: entry.name,
      namespaces: state.namespaces,
      fullName,
      methods: entry.methods,
      extraKwargs,
    })
  }
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function encodePathValue(v: string): string {
  return encodeURIComponent(v).replace(/%(2F|3A|40|24|26|2B|2C|3B|3D|7E)/gi, (m) => decodeURIComponent(m))
}

/** A compiled urlconf: resolves paths, reverses names and mounts itself onto a Hono app. */
export class UrlResolver {
  readonly routes: CompiledRoute[] = []
  private byName = new Map<string, CompiledRoute[]>()

  constructor(readonly patterns: UrlPatterns) {
    flatten(patterns, { parts: [], namespaces: [], extraKwargs: {} }, this.routes)
    for (const r of this.routes) {
      if (!r.fullName) continue
      const list = this.byName.get(r.fullName) ?? []
      list.push(r)
      this.byName.set(r.fullName, list)
    }
  }

  /** All namespaced names (for debugging / tooling). */
  get names(): string[] {
    return [...this.byName.keys()]
  }

  /** All routes matching `path` (in order). */
  matchAll(path: string): ResolverMatch[] {
    const p = path.replace(/^\//, '')
    const out: ResolverMatch[] = []
    for (const r of this.routes) {
      const m = r.regex.exec(p)
      if (!m) continue
      const groups: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) groups[k] = v === undefined ? undefined : decode(v)
      out.push(buildMatch(r, groups))
    }
    return out
  }

  /** First match for `path` (and `method`, if given), or null. */
  match(path: string, method?: string): ResolverMatch | null {
    const m = method?.toUpperCase() === 'HEAD' ? 'GET' : method?.toUpperCase()
    for (const r of this.matchAll(path)) {
      if (!m || !r.methods || r.methods.includes(m) || (m === 'GET' && r.methods.includes('HEAD'))) return r
    }
    return null
  }

  /** Django's `resolve()`: throws Resolver404 if nothing matches. */
  resolve(path: string): ResolverMatch {
    const m = this.match(path)
    if (!m) throw new Resolver404(`No URL pattern matches '${path}'.`)
    return m
  }

  isValidPath(path: string): boolean {
    return this.match(path) !== null
  }

  reverse(
    name: string,
    params: Record<string, unknown> | unknown[] = {},
    opts: { query?: Record<string, unknown> | URLSearchParams | string } = {},
  ): string {
    const candidates = this.byName.get(name)
    if (!candidates?.length) {
      throw new NoReverseMatch(
        `Reverse for '${name}' not found. '${name}' is not a valid view function or pattern name.`,
      )
    }
    for (const route of candidates) {
      const url = UrlResolver.tryReverse(route, params)
      if (url !== null) return url + queryString(opts.query)
    }
    const given = Array.isArray(params)
      ? `arguments ${JSON.stringify(params)}`
      : `keyword arguments ${JSON.stringify(params)}`
    throw new NoReverseMatch(
      `Reverse for '${name}' with ${given} not found. ${candidates.length} pattern(s) tried: ${candidates
        .map((c) => `'${c.pattern}'`)
        .join(', ')}`,
    )
  }

  private static tryReverse(
    route: CompiledRoute,
    params: Record<string, unknown> | unknown[],
  ): string | null {
    if (!route.tokens) return null
    const paramTokens = route.tokens.filter((t): t is Extract<Token, { param: string }> => 'param' in t)
    let values: Record<string, unknown>
    if (Array.isArray(params)) {
      if (params.length !== paramTokens.length) return null
      values = Object.fromEntries(paramTokens.map((t, i) => [t.param, params[i]]))
    } else {
      const keys = Object.keys(params).filter((k) => params[k] !== undefined)
      const expected = new Set(paramTokens.map((t) => t.param))
      for (const k of keys) {
        if (!expected.has(k) && !(k in route.extraKwargs && route.extraKwargs[k] === params[k])) return null
      }
      for (const k of expected) if (!keys.includes(k)) return null
      values = params
    }
    let out = ''
    for (const t of route.tokens) {
      if ('lit' in t) {
        out += t.lit
        continue
      }
      const text = t.converter.toUrl(values[t.param])
      if (!new RegExp(`^(?:${t.regex})$`).test(text)) return null
      out += encodePathValue(text)
    }
    return `/${out}`
  }

  /** Register every route on a Hono app (in order: first match wins, like Django). */
  mount(hono: HonoApp): void {
    for (const route of this.routes) {
      if (route.kind === 'app') {
        hono.route(route.honoPath!, route.app!)
        continue
      }
      const handler = makeRouteHandler(route)
      if (route.honoPath === null) {
        hono.all('*', handler)
      } else if (route.methods) {
        hono.on(route.methods, route.honoPath, handler)
      } else {
        hono.all(route.honoPath, handler)
      }
    }
  }
}

function queryString(q: Record<string, unknown> | URLSearchParams | string | undefined): string {
  if (q === undefined) return ''
  if (typeof q === 'string') return q ? (q.startsWith('?') ? q : `?${q}`) : ''
  const sp = q instanceof URLSearchParams ? q : new URLSearchParams()
  if (!(q instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) for (const x of v) sp.append(k, String(x))
      else sp.append(k, String(v))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// ---------------------------------------------------------------------------------------------
// Request-time helpers
// ---------------------------------------------------------------------------------------------

const MATCHES = new WeakMap<object, ResolverMatch>()
/** Marker set on views by `csrfExempt()`. */
export const CSRF_EXEMPT_MARKER: symbol = Symbol.for('ghuri.csrfExempt')
const CSRF_EXEMPT = CSRF_EXEMPT_MARKER

function makeRouteHandler(route: CompiledRoute) {
  const handler = async (c: Context, next: Next): Promise<Response | void> => {
    let match: ResolverMatch
    if (route.honoPath === null) {
      if (route.methods) {
        const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
        if (!route.methods.includes(method)) return next()
      }
      const m = route.regex.exec(c.req.path.replace(/^\//, ''))
      if (!m) return next()
      const groups: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) groups[k] = v === undefined ? undefined : decode(v)
      match = buildMatch(route, groups)
    } else {
      match = buildMatch(route, c.req.param() as Record<string, string>)
    }
    MATCHES.set(c, match)
    let res: Response | undefined
    try {
      res = await route.view!(c)
    } catch (err) {
      if (err instanceof Response) return err
      throw err
    }
    if (!(res instanceof Response)) {
      throw new ImproperlyConfigured(
        `The view for '${route.pattern}' didn't return a Response. It returned ${res === undefined ? 'undefined' : typeof res} instead.`,
      )
    }
    return res
  }
  if ((route.view as any)?.[CSRF_EXEMPT] && route.honoPath !== null) (handler as any)[CSRF_EXEMPT] = true
  return handler
}

function buildMatch(route: CompiledRoute, groups: Record<string, string | undefined>): ResolverMatch {
  const kwargs: Record<string, any> = { ...route.extraKwargs }
  for (const p of route.params) {
    const raw = groups[p.name]
    if (raw !== undefined) kwargs[p.name] = p.converter.toJs(raw)
  }
  return {
    route: route.pattern,
    urlName: route.name,
    namespace: route.namespaces.join(':'),
    namespaces: route.namespaces,
    viewName: route.fullName,
    kwargs,
    view: route.view,
    app: route.app,
    methods: route.methods,
    compiled: route,
  }
}

/** The ResolverMatch of the current request (Django's `request.resolver_match`). */
export function resolverMatch(c: Context): ResolverMatch | undefined {
  return MATCHES.get(c)
}

/**
 * URL parameters of the current request, converted by their converters (`<int:id>` → number), plus any
 * extra `kwargs` given to `path()`.
 */
export function kwargs<T extends Record<string, any> = Record<string, any>>(c: Context): T {
  const m = MATCHES.get(c)
  if (m) return m.kwargs as T
  return { ...(c.req.param() as Record<string, string>) } as unknown as T
}

const URLCONFS = new WeakMap<object, UrlResolver>()

/** Compiled resolver for a urlconf (cached per patterns array). */
export function getResolver(patterns?: UrlPatterns): UrlResolver {
  const pats = patterns ?? (tryGetContext()?.settings.ROOT_URLCONF as UrlPatterns | undefined)
  if (!pats) {
    throw new ImproperlyConfigured(
      'No urlconf: pass one explicitly or call reverse()/resolve() inside a Ghuri context.',
    )
  }
  let r = URLCONFS.get(pats)
  if (!r) {
    r = new UrlResolver(pats)
    URLCONFS.set(pats, r)
  }
  return r
}

export interface ReverseOptions {
  urlconf?: UrlPatterns
  query?: Record<string, unknown> | URLSearchParams | string
}

/**
 * Django's `reverse()`: `reverse('blog:post-detail', { id: 3 })` → `/blog/posts/3/`.
 * Positional params (`reverse('x', [3])`) also work.
 */
export function reverse(
  name: string,
  params?: Record<string, unknown> | unknown[],
  opts: ReverseOptions = {},
): string {
  return getResolver(opts.urlconf).reverse(name, params, opts)
}

/** Django's `resolve()`. */
export function resolve(pathname: string, opts: { urlconf?: UrlPatterns } = {}): ResolverMatch {
  return getResolver(opts.urlconf).resolve(pathname)
}
