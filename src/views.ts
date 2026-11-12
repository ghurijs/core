import type { Context, HonoRequest } from 'hono'
import { jsx } from 'hono/jsx'
import { ImproperlyConfigured, MethodNotAllowed } from './errors'
import { handleException } from './exceptions'
import {
  CSRF_EXEMPT_MARKER,
  kwargs as getKwargs,
  NoReverseMatch,
  reverse,
  type ViewFunction,
  XFRAME_OPTIONS_EXEMPT_MARKER,
} from './urls'

export type { ViewFunction } from './urls'

/** Function returned by `View.asView()`. */
export interface AsViewFunction<V extends View = View> extends ViewFunction {
  viewClass: new () => V
  viewInitkwargs: Partial<V>
}

export type HttpMethodName = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace'

type Handler = (c: Context) => Response | Promise<Response>

/**
 * Django's class-based `View`. Subclass it and implement `get` / `post` / … handlers; mount it with
 * `path('x/', MyView.asView())`. A new instance is created for every request.
 *
 * ```ts
 * class Hello extends View {
 *   greeting = 'Hello'
 *   async get(c: Context) { return c.text(`${this.greeting}, ${this.kwargs.name}`) }
 * }
 * path('hello/<name>/', Hello.asView({ greeting: 'Hi' }))
 * ```
 */
export abstract class View {
  static httpMethodNames: HttpMethodName[] = [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'head',
    'options',
    'trace',
  ]
  /** Mark every view produced by `asView()` as CSRF exempt. */
  static csrfExempt = false
  /** Mark every view produced by `asView()` as exempt from `XFrameOptionsMiddleware`. */
  static xframeOptionsExempt = false

  /** The Hono context of the current request. */
  c!: Context
  /** The Hono request (Django's `self.request`). */
  request!: HonoRequest
  /** URL parameters (converted), see `kwargs(c)`. */
  kwargs: Record<string, any> = {}

  get?(c: Context): Response | Promise<Response>
  post?(c: Context): Response | Promise<Response>
  put?(c: Context): Response | Promise<Response>
  patch?(c: Context): Response | Promise<Response>
  delete?(c: Context): Response | Promise<Response>
  head?(c: Context): Response | Promise<Response>
  trace?(c: Context): Response | Promise<Response>

  /** Build a view function. `initkwargs` override instance attributes (like Django). */
  static asView<V extends View>(this: new () => V, initkwargs: Partial<V> = {}): AsViewFunction<V> {
    const cls = this as unknown as (new () => V) & {
      httpMethodNames: HttpMethodName[]
      csrfExempt?: boolean
      xframeOptionsExempt?: boolean
      name: string
    }
    for (const key of Object.keys(initkwargs)) {
      if ((cls.httpMethodNames as string[]).includes(key)) {
        throw new ImproperlyConfigured(
          `The method name ${key} is not accepted as a keyword argument to ${cls.name}.asView().`,
        )
      }
    }
    const view = (async (c: Context) => {
      const self = new cls()
      Object.assign(self, initkwargs)
      self.setup(c)
      return self.dispatch(c)
    }) as AsViewFunction<V>
    view.viewClass = cls
    view.viewInitkwargs = initkwargs
    Object.defineProperty(view, 'name', { value: cls.name })
    if (cls.csrfExempt) (view as any)[CSRF_EXEMPT_MARKER] = true
    if (cls.xframeOptionsExempt) (view as any)[XFRAME_OPTIONS_EXEMPT_MARKER] = true
    return view
  }

  /** Initialize attributes shared by all handlers (Django's `setup()`). */
  setup(c: Context): void {
    this.c = c
    this.request = c.req
    this.kwargs = { ...getKwargs(c), ...this.kwargs }
  }

  /** Route to the handler for the request method, or `httpMethodNotAllowed`. */
  async dispatch(c: Context): Promise<Response> {
    const method = c.req.method.toLowerCase()
    const names = (this.constructor as typeof View).httpMethodNames as string[]
    let handler: Handler | undefined
    if (names.includes(method)) handler = (this as any)[method]
    if (!handler && method === 'head' && typeof this.get === 'function') handler = this.get
    if (typeof handler !== 'function') return this.httpMethodNotAllowed(c)
    return handler.call(this, c)
  }

  /** Allowed HTTP methods (upper case), used for the `Allow` header. */
  allowedMethods(): string[] {
    const names = (this.constructor as typeof View).httpMethodNames as string[]
    const out = names.filter((m) => typeof (this as any)[m] === 'function').map((m) => m.toUpperCase())
    if (out.includes('GET') && !out.includes('HEAD')) out.splice(out.indexOf('GET') + 1, 0, 'HEAD')
    return out
  }

  httpMethodNotAllowed(c: Context): Response | Promise<Response> {
    return handleException(new MethodNotAllowed(c.req.method, this.allowedMethods()), c)
  }

  /** Default OPTIONS handler: 200 with an `Allow` header. */
  options(_c: Context): Response | Promise<Response> {
    return new Response(null, {
      status: 200,
      headers: { Allow: this.allowedMethods().join(', '), 'Content-Length': '0' },
    })
  }
}

/** Something renderable by `render()`: a Hono JSX node, a string, or a promise of either. */
export type Renderable = unknown

export interface RenderOptions {
  status?: number
  headers?: Record<string, string>
  /** Prepend `<!DOCTYPE html>` when the output starts with `<html` (default true). */
  doctype?: boolean
}

/** Render Hono JSX (or an HTML string) to an HTML response. */
export async function render(c: Context, node: Renderable, opts: RenderOptions = {}): Promise<Response> {
  let html: string
  const resolved = await node
  if (resolved === null || resolved === undefined || resolved === false) html = ''
  else html = String(await (typeof resolved === 'string' ? resolved : (resolved as any).toString()))
  if (opts.doctype !== false && /^\s*<html[\s>]/i.test(html)) html = `<!DOCTYPE html>${html}`
  return c.html(html, (opts.status ?? 200) as any, opts.headers)
}

/** Template: a Hono JSX component (sync or async) receiving the context data as props. */
export type Template<P = any> = (props: P) => unknown

/**
 * Render a JSX `template` with `getContextData()` (Django's TemplateView).
 *
 * ```tsx
 * class About extends TemplateView {
 *   template = (p: { title: string }) => <h1>{p.title}</h1>
 *   async getContextData() { return { ...(await super.getContextData()), title: 'About us' } }
 * }
 * ```
 */
export class TemplateView extends View {
  template?: Template
  /** Extra context merged into every render (Django's `extra_context`). */
  extraContext?: Record<string, unknown>
  status = 200

  async getContextData(extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
    return { view: this, ...this.kwargs, ...this.extraContext, ...extra }
  }

  getTemplate(): Template {
    if (!this.template) {
      throw new ImproperlyConfigured(
        `${this.constructor.name} requires either a definition of 'template' or an implementation of 'getTemplate()'.`,
      )
    }
    return this.template
  }

  async renderToResponse(context: Record<string, any>, opts: RenderOptions = {}): Promise<Response> {
    return render(this.c, jsx(this.getTemplate() as any, context), { status: this.status, ...opts })
  }

  override async get(_c: Context): Promise<Response> {
    return this.renderToResponse(await this.getContextData())
  }
}

/**
 * Redirect to `url` (with `{param}` placeholders filled from the URL kwargs) or to the named `patternName`.
 * Returns 410 Gone when neither is set. Like Django, every method is redirected.
 */
export class RedirectView extends View {
  url?: string
  patternName?: string
  permanent = false
  queryString = false

  getRedirectUrl(): string | null {
    let url: string
    if (this.url) {
      url = this.url.replace(/\{(\w+)\}|%\((\w+)\)s/g, (m, a, b) => {
        const k = a ?? b
        return k in this.kwargs ? encodeURIComponent(String(this.kwargs[k])) : m
      })
    } else if (this.patternName) {
      url = reverse(this.patternName, this.kwargs)
    } else {
      return null
    }
    const search = new URL(this.c.req.url).search
    if (this.queryString && search) url += url.includes('?') ? `&${search.slice(1)}` : search
    return url
  }

  override async get(_c: Context): Promise<Response> {
    const url = this.getRedirectUrl()
    if (url === null) return new Response(null, { status: 410 })
    return new Response(null, { status: this.permanent ? 301 : 302, headers: { Location: url } })
  }
  override head(c: Context) {
    return this.get(c)
  }
  override post(c: Context) {
    return this.get(c)
  }
  override options(c: Context) {
    return this.get(c)
  }
  override delete(c: Context) {
    return this.get(c)
  }
  override put(c: Context) {
    return this.get(c)
  }
  override patch(c: Context) {
    return this.get(c)
  }
}

// ---------------------------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------------------------

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof Set) return [...value]
  return value
}

/** JSON-encode a value the way `json()` does (bigint → number/string, Map → object, Set → array). */
export function toJson(data: unknown, space?: number): string {
  return JSON.stringify(data, jsonReplacer, space)
}

/** JSON response: `return json(c, { ok: true }, 201)`. */
export function json(c: Context, data: unknown, status = 200, headers?: Record<string, string>): Response {
  return c.body(toJson(data), status as any, {
    'Content-Type': 'application/json; charset=UTF-8',
    ...headers,
  })
}

/**
 * Django's `resolve_url`: a URL name (reversed with `params`), an object with `getAbsoluteUrl()`, or a URL.
 */
export function resolveUrl(
  to: string | { getAbsoluteUrl(): string },
  params?: Record<string, unknown> | unknown[],
): string {
  if (typeof to === 'object' && to && typeof to.getAbsoluteUrl === 'function') return to.getAbsoluteUrl()
  const target = String(to)
  if (/^(\.\.?\/|\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(target)) return target
  try {
    return reverse(target, params)
  } catch (err) {
    if (err instanceof NoReverseMatch && (target.includes('/') || target.includes('.'))) return target
    throw err
  }
}

/** Redirect to a URL name (`redirect(c, 'blog:detail', { id })`), a model with `getAbsoluteUrl()`, or a URL. */
export function redirect(
  c: Context,
  to: string | { getAbsoluteUrl(): string },
  params?: Record<string, unknown> | unknown[],
  opts: { permanent?: boolean; status?: number } = {},
): Response {
  const status = opts.status ?? (opts.permanent ? 301 : 302)
  return c.redirect(resolveUrl(to, params), status as any)
}
