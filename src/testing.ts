// @ghuri/core/testing — Django-style test client. Fetch-based: works on Node and inside Workers (vitest-pool-workers).
import { type Env, type ExecutionContextLike, type GhuriContext, runWithContext } from './context'
import { generateCsrfSecret } from './csrf'

/** Anything with a Workers-style `fetch` (a GhuriApp, a Hono app, …). */
export interface TestableApp {
  fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Response | Promise<Response>
  setup?(env?: Env): Promise<GhuriContext>
}

export interface TestClientOptions {
  env?: Env
  /** Base URL of requests (default `http://testserver`). */
  baseUrl?: string
  /** Default headers for every request. */
  headers?: Record<string, string>
  /**
   * Send the CSRF token automatically on unsafe requests (default true). The token comes from the
   * `csrftoken` cookie; if there is none yet, the client creates one (like a browser that loaded a form).
   * Set to false to test CSRF failures.
   */
  csrf?: boolean
  csrfCookieName?: string
  csrfHeaderName?: string
}

export interface RequestOptions {
  /** JSON body (sets Content-Type: application/json). */
  json?: unknown
  /** Form body: urlencoded, or multipart when it contains a Blob/File or is a FormData. */
  form?: Record<string, unknown> | FormData
  /** Raw body. */
  body?: BodyInit | null
  headers?: Record<string, string>
  /** Query string parameters (arrays repeat the key). */
  query?: Record<string, unknown> | URLSearchParams
  /** Follow redirects (Django's `follow=True`), max 20 hops. */
  follow?: boolean
  /** Override `csrf` for this request. */
  csrf?: boolean
}

export interface TestResponse extends Response {
  /** Redirects followed (`follow: true`): `[url, status][]`. */
  redirectChain: Array<[string, number]>
  /** The request that produced this response. */
  request: Request
}

export interface Cookie {
  name: string
  value: string
  path?: string
  expires?: Date
}

/** Hook used by packages to extend the client (e.g. `@ghuri/auth` implements `forceLogin`). */
export type TestClientHook = (client: TestClient, ...args: any[]) => unknown | Promise<unknown>

const HOOKS_KEY = Symbol.for('ghuri.core.testClientHooks')
const hooks: Map<string, TestClientHook> = ((globalThis as any)[HOOKS_KEY] ??= new Map())

/**
 * Register a test-client extension: `registerTestClientHook('forceLogin', async (client, user) => {...})`.
 * Built-in hook names used by `TestClient`: `forceLogin`, `login`, `logout`.
 */
export function registerTestClientHook(name: string, fn: TestClientHook): void {
  hooks.set(name, fn)
}

export function getTestClientHook(name: string): TestClientHook | undefined {
  return hooks.get(name)
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function parseSetCookie(header: string): Cookie & { delete: boolean } {
  const [pair, ...attrs] = header.split(';')
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq).trim()
  let value = pair.slice(eq + 1).trim()
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  try {
    value = decodeURIComponent(value)
  } catch {
    // keep raw
  }
  const cookie: Cookie & { delete: boolean } = { name, value, delete: false }
  for (const attr of attrs) {
    const [k, ...rest] = attr.trim().split('=')
    const v = rest.join('=')
    const key = k.toLowerCase()
    if (key === 'max-age' && Number(v) <= 0) cookie.delete = true
    if (key === 'expires') {
      const d = new Date(v)
      cookie.expires = d
      if (!Number.isNaN(d.getTime()) && d.getTime() <= Date.now()) cookie.delete = true
    }
    if (key === 'path') cookie.path = v
  }
  return cookie
}

function appendQuery(url: URL, query: RequestOptions['query']): void {
  if (!query) return
  if (query instanceof URLSearchParams) {
    for (const [k, v] of query) url.searchParams.append(k, v)
    return
  }
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x))
    else url.searchParams.append(k, String(v))
  }
}

/** Django's test `Client`, for Ghuri apps. */
export class TestClient {
  readonly env: Env
  readonly baseUrl: string
  readonly cookies = new Map<string, Cookie>()
  readonly defaultHeaders: Record<string, string>
  private pending: Promise<unknown>[] = []
  private readonly csrf: boolean
  private readonly csrfCookieName: string
  private readonly csrfHeaderName: string

  constructor(
    readonly app: TestableApp,
    opts: TestClientOptions = {},
  ) {
    this.env = opts.env ?? {}
    this.baseUrl = opts.baseUrl ?? 'http://testserver'
    this.defaultHeaders = { ...opts.headers }
    this.csrf = opts.csrf ?? true
    this.csrfCookieName = opts.csrfCookieName ?? 'csrftoken'
    this.csrfHeaderName = opts.csrfHeaderName ?? 'X-CSRFToken'
  }

  /** ExecutionContext handed to the app; `waitUntil` promises can be awaited with `waitForBackgroundTasks()`. */
  readonly executionCtx: ExecutionContextLike = {
    waitUntil: (p) => {
      this.pending.push(Promise.resolve(p).catch((err) => console.error('waitUntil task failed:', err)))
    },
    passThroughOnException: () => {},
  }

  async waitForBackgroundTasks(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending
      this.pending = []
      await Promise.all(batch)
    }
  }

  // ------------------------------------------------------------------ cookies
  getCookie(name: string): string | undefined {
    return this.cookies.get(name)?.value
  }

  setCookie(name: string, value: string, opts: Omit<Cookie, 'name' | 'value'> = {}): void {
    this.cookies.set(name, { name, value, ...opts })
  }

  deleteCookie(name: string): void {
    this.cookies.delete(name)
  }

  clearCookies(): void {
    this.cookies.clear()
  }

  private cookieHeader(): string | undefined {
    const now = Date.now()
    const parts: string[] = []
    for (const c of this.cookies.values()) {
      if (c.expires && c.expires.getTime() <= now) {
        this.cookies.delete(c.name)
        continue
      }
      parts.push(`${c.name}=${encodeURIComponent(c.value)}`)
    }
    return parts.length ? parts.join('; ') : undefined
  }

  private storeCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?(): string[] }
    const list = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])
    for (const h of list) {
      const c = parseSetCookie(h)
      if (!c.name) continue
      if (c.delete) this.cookies.delete(c.name)
      else this.cookies.set(c.name, { name: c.name, value: c.value, path: c.path, expires: c.expires })
    }
  }

  // ------------------------------------------------------------------ requests
  /** Build the Request a call would send (without sending it). */
  buildRequest(method: string, path: string, opts: RequestOptions = {}): Request {
    const url = new URL(path, this.baseUrl)
    appendQuery(url, opts.query)
    const headers = new Headers(this.defaultHeaders)
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v)
    let body: BodyInit | null | undefined = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    } else if (opts.form !== undefined) {
      const form = opts.form
      const multipart =
        form instanceof FormData ||
        Object.values(form).some(
          (v) => v instanceof Blob || (Array.isArray(v) && v.some((x) => x instanceof Blob)),
        )
      if (multipart) {
        let fd: FormData
        if (form instanceof FormData) {
          fd = form
        } else {
          fd = new FormData()
          for (const [k, v] of Object.entries(form)) {
            for (const x of Array.isArray(v) ? v : [v]) {
              if (x === undefined || x === null) continue
              fd.append(k, x instanceof Blob ? x : String(x))
            }
          }
        }
        body = fd
      } else {
        const sp = new URLSearchParams()
        for (const [k, v] of Object.entries(form as Record<string, unknown>)) {
          for (const x of Array.isArray(v) ? v : [v])
            if (x !== undefined && x !== null) sp.append(k, String(x))
        }
        body = sp.toString()
        if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded')
      }
    }
    const upper = method.toUpperCase()
    const csrf = opts.csrf ?? this.csrf
    if (csrf && UNSAFE.has(upper) && !headers.has(this.csrfHeaderName)) {
      let token = this.getCookie(this.csrfCookieName)
      if (!token) {
        token = generateCsrfSecret()
        this.setCookie(this.csrfCookieName, token)
      }
      headers.set(this.csrfHeaderName, token)
    }
    const cookie = this.cookieHeader()
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
    return new Request(url, {
      method: upper,
      headers,
      body: upper === 'GET' || upper === 'HEAD' ? undefined : body,
    })
  }

  /** Send a raw Request through the app (cookies are still recorded). */
  async fetch(request: Request): Promise<Response> {
    const res = await this.app.fetch(request, this.env, this.executionCtx)
    this.storeCookies(res)
    return res
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<TestResponse> {
    const chain: Array<[string, number]> = []
    let req = this.buildRequest(method, path, opts)
    let res = await this.fetch(req)
    if (opts.follow) {
      let hops = 0
      while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 20) {
        const location = new URL(res.headers.get('location')!, req.url)
        chain.push([location.pathname + location.search, res.status])
        const keepMethod = res.status === 307 || res.status === 308
        const nextMethod = keepMethod ? method : method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
        const nextOpts: RequestOptions = keepMethod
          ? { ...opts, query: undefined }
          : { headers: opts.headers }
        req = this.buildRequest(nextMethod, location.toString(), nextOpts)
        res = await this.fetch(req)
      }
    }
    return Object.assign(res, { redirectChain: chain, request: req }) as TestResponse
  }

  get(path: string, opts?: RequestOptions) {
    return this.request('GET', path, opts)
  }
  head(path: string, opts?: RequestOptions) {
    return this.request('HEAD', path, opts)
  }
  options(path: string, opts?: RequestOptions) {
    return this.request('OPTIONS', path, opts)
  }
  post(path: string, opts?: RequestOptions) {
    return this.request('POST', path, opts)
  }
  put(path: string, opts?: RequestOptions) {
    return this.request('PUT', path, opts)
  }
  patch(path: string, opts?: RequestOptions) {
    return this.request('PATCH', path, opts)
  }
  delete(path: string, opts?: RequestOptions) {
    return this.request('DELETE', path, opts)
  }

  // ------------------------------------------------------------------ context & hooks
  /** `app.setup(env)`: populate apps and install the global context (for DB access in tests). */
  async setup(): Promise<GhuriContext | undefined> {
    return this.app.setup?.(this.env)
  }

  /** Run `fn` inside a fresh Ghuri context for this client's env (e.g. to create fixtures). */
  async withContext<T>(fn: (ctx: GhuriContext) => T | Promise<T>): Promise<T> {
    if (!this.app.setup) throw new TypeError('withContext() needs a GhuriApp (with setup()).')
    const base = await this.app.setup(this.env)
    const ctx: GhuriContext = { ...base, state: new Map() }
    return runWithContext(ctx, () => fn(ctx))
  }

  /** Call a registered hook by name. */
  async callHook<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const hook = hooks.get(name)
    if (!hook) {
      throw new Error(
        `No test client hook '${name}' is registered. Is the package that provides it (e.g. @ghuri/auth) imported?`,
      )
    }
    return (await hook(this, ...args)) as T
  }

  /** Log `user` in without credentials (provided by `@ghuri/auth`). */
  forceLogin(user: unknown, opts?: Record<string, unknown>): Promise<void> {
    return this.callHook('forceLogin', user, opts)
  }

  /** Log in with credentials (provided by `@ghuri/auth`). Resolves to true on success. */
  login(credentials: Record<string, unknown>): Promise<boolean> {
    return this.callHook('login', credentials)
  }

  /** Log out (uses the `logout` hook when registered, then clears all cookies). */
  async logout(): Promise<void> {
    if (hooks.has('logout')) await this.callHook('logout')
    this.clearCookies()
  }
}

/** Create a test client: `const client = createTestClient(app, { env })`. */
export function createTestClient(app: TestableApp, opts: TestClientOptions = {}): TestClient {
  return new TestClient(app, opts)
}
