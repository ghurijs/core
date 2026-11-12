# @ghuri/core

The foundation of [Ghuri](https://github.com/ghurijs/ghuri) — Django for TypeScript, Cloudflare first.

`@ghuri/core` gives you Django's project structure on top of [Hono](https://hono.dev): settings,
installed apps, `urls` with `path()` / `include()` / `reverse()`, function and class-based views,
middleware (security, CSRF, CORS, …), a per-request context, signals, a cache API, system checks,
management-command plumbing, a Node adapter and a test client.

It runs on **Cloudflare Workers** (with `nodejs_compat`) by default and on **Node.js** with the same code.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```bash
npm install @ghuri/core@next hono
```

## Contents

- [Quick start](#quick-start)
- [Settings](#settings)
- [Apps](#apps)
- [URLs](#urls)
- [Views](#views)
- [Errors](#errors)
- [Middleware](#middleware)
- [Request context](#request-context)
- [Signals](#signals)
- [Cache](#cache)
- [Cron triggers and queues](#cron-triggers-and-queues)
- [Management commands](#management-commands)
- [System checks](#system-checks)
- [Running on Node](#running-on-node)
- [Testing](#testing)

## Quick start

```ts
// src/settings.ts
import { CommonMiddleware, CsrfMiddleware, SecurityMiddleware, defineSettings, kvCache } from '@ghuri/core'
import { BlogConfig } from './blog/app'
import { urlpatterns } from './urls'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: ['example.com', '.example.com'],
  INSTALLED_APPS: [BlogConfig],
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, CsrfMiddleware],
  ROOT_URLCONF: urlpatterns,
  CACHES: { default: kvCache('CACHE') },
}))
```

```ts
// src/urls.ts
import { include, path } from '@ghuri/core'
import { blogUrls } from './blog/urls'

export const urlpatterns = [
  path('', (c) => c.text('Hello from Ghuri'), { name: 'home' }),
  path('blog/', include(blogUrls)),
]
```

```ts
// src/index.ts — the Worker entry (Django's wsgi.py)
import { createApp } from '@ghuri/core'
import settings from './settings'

export default createApp(settings)
```

`wrangler dev` and you're running. The same app runs on Node with `serve()` from `@ghuri/core/node`.

## Settings

Settings are a function of the runtime environment: Worker bindings and vars on Cloudflare,
`process.env` on Node. `defineSettings()` resolves them once per `env` object, applies defaults and
validates them.

```ts
export default defineSettings((env) => ({ SECRET_KEY: env.SECRET_KEY, INSTALLED_APPS: [], ROOT_URLCONF: [] }))
```

Read them anywhere inside a request (or after `app.setup(env)`):

```ts
import { getSettings, setting } from '@ghuri/core'

getSettings().DEBUG
setting('PAGE_SIZE', 20) // with a fallback
```

| Setting | Default | |
|---|---|---|
| `SECRET_KEY` | — (required unless `DEBUG`) | Signing secret. Store it with `wrangler secret put SECRET_KEY`. |
| `DEBUG` | `false` | Debug error pages, startup system checks. |
| `ALLOWED_HOSTS` | `['*']` | Host validation (`'.example.com'` matches subdomains). With `DEBUG` and `[]`, localhost is allowed. |
| `INSTALLED_APPS` | — | `AppConfig` classes or instances. |
| `MIDDLEWARE` | `[]` | Middleware classes, instances, or plain Hono middleware. |
| `ROOT_URLCONF` | — | Your URL patterns. |
| `APPEND_SLASH` | `true` | Redirect `/x` → `/x/` when only the slashed URL exists. |
| `HANDLER_404` | — | Custom 404 view `(c, exception) => Response` (Django's `handler404`). See [Errors](#errors). |
| `HANDLER_500` | — | Custom 500 view `(c, exception) => Response` (Django's `handler500`). See [Errors](#errors). |
| `CACHES` | in-memory | `{ default: kvCache('CACHE') }` |
| `CSRF_TRUSTED_ORIGINS` | `[]` | e.g. `['https://*.example.com']` |
| `CORS` | `false` | `{ allowOrigins: ['https://app.example.com'], allowCredentials: true }` |
| `TIME_ZONE` / `USE_TZ` | `'UTC'` / `true` | |
| `API_PATH_PREFIXES` | `['/api']` | Errors under these paths are always JSON. |

Security and CSRF settings use Django's names: `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`,
`SECURE_HSTS_INCLUDE_SUBDOMAINS`, `SECURE_HSTS_PRELOAD`, `SECURE_PROXY_SSL_HEADER`,
`SECURE_REFERRER_POLICY`, `SECURE_CROSS_ORIGIN_OPENER_POLICY`, `SECURE_CONTENT_TYPE_NOSNIFF`,
`X_FRAME_OPTIONS`, `USE_X_FORWARDED_HOST`, `PREPEND_WWW`, `CSRF_COOKIE_NAME`, `CSRF_HEADER_NAME`,
`CSRF_COOKIE_SECURE`, `CSRF_COOKIE_HTTPONLY`, `CSRF_COOKIE_SAMESITE`, `CSRF_COOKIE_AGE`,
`CSRF_COOKIE_DOMAIN`, `CSRF_COOKIE_PATH`, `SILENCED_SYSTEM_CHECKS`.

Other packages add their own keys (`DATABASES`, `STORAGES`, `REST_FRAMEWORK`, …) with declaration merging:

```ts
declare module '@ghuri/core' {
  interface GhuriSettings { MY_FEATURE?: { enabled: boolean } }
}
```

## Apps

```ts
// src/blog/app.ts
import { AppConfig } from '@ghuri/core'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  models = models
  path = import.meta.dirname // used by the CLI for migrations

  ready() {
    // connect signals, register cron handlers, …
  }
}
```

`apps.populate(INSTALLED_APPS)` runs once per isolate before the first request: configs are
instantiated, packages' `onPopulate` hooks run (the ORM registers models), then each `ready()`.

```ts
import { apps } from '@ghuri/core'
apps.getAppConfig('blog'); apps.isInstalled('auth'); apps.getModel('blog.Post')
```

## URLs

```ts
import { include, path, rePath, urlpatterns } from '@ghuri/core'

export const blogUrls = urlpatterns('blog', [            // app_name = 'blog'
  path('', postList, { name: 'list' }),
  path('<slug:slug>/', PostDetail, { name: 'detail' }),   // View classes are accepted directly
])

export const root = [
  path('', home, { name: 'home' }),
  path('blog/', include(blogUrls)),                       // namespace 'blog' from appName
  path('v2/blog/', include(blogUrls, { namespace: 'blog-v2' })),
  path('posts/<int:id>/', PostView.asView(), { name: 'post-detail' }),
  rePath('^archive/(?P<year>[0-9]{4})/$', archive, { name: 'archive' }),
  path('upload/', upload, { methods: ['POST'] }),         // other methods → 405
  path('page/', page, { kwargs: { template: 'about' } }), // extra kwargs for the view
  path('legacy/', someHonoApp),                           // escape hatch: mount any Hono app
]
```

**Converters** (Django's): `<int:x>`, `<str:x>` (default), `<slug:x>`, `<uuid:x>`, `<path:x>`. They are
compiled to Hono route patterns (`/posts/:id{[0-9]+}/`), so routing stays fast. Raw values are in
`c.req.param()`; converted values (numbers for `int`) plus extra kwargs come from `kwargs(c)`:

```ts
import { kwargs } from '@ghuri/core'
const postDetail = (c: Context) => c.json({ id: kwargs<{ id: number }>(c).id })
```

Add your own converter:

```ts
registerConverter('year', { regex: '[0-9]{4}', toJs: Number, toUrl: (v) => String(v).padStart(4, '0') })
path('archive/<year:y>/', archive)
```

Routes Hono can't express (two parameters in one segment, complex `rePath` regexes) fall back to
regex matching automatically; their parameters are available through `kwargs(c)`.

**Reversing** — `reverse(name, params?, { query? })`, with namespaces:

```ts
reverse('home')                              // '/'
reverse('blog:detail', { slug: 'hello' })    // '/blog/hello/'
reverse('post-detail', [42])                 // positional params
reverse('blog:list', {}, { query: { page: 2 } }) // '/blog/?page=2'
```

`resolve(path)` returns a `ResolverMatch` (`urlName`, `namespace`, `viewName`, `kwargs`, …);
`resolverMatch(c)` gives the current request's match. Patterns run in order — first match wins.

## Views

A view is a Hono handler: `(c: Context) => Response | Promise<Response>`. Throwing a `Response` returns it.

```ts
import { json, redirect, render } from '@ghuri/core'

export const home = (c: Context) => render(c, <HomePage user={c.get('user')} />)
export const api = (c: Context) => json(c, { ok: true }, 201)       // bigint/Map/Set aware
export const go = (c: Context) => redirect(c, 'blog:detail', { slug: 'x' }) // name, URL or obj.getAbsoluteUrl()
```

**Class-based views** — a new instance per request; `asView(initkwargs)` overrides attributes:

```ts
import { RedirectView, TemplateView, View } from '@ghuri/core'

class PostView extends View {
  greeting = 'Hello'
  async get(c: Context) {
    return json(c, { id: this.kwargs.id, greeting: this.greeting })
  }
  async post(c: Context) { /* … */ }
}
path('posts/<int:id>/', PostView.asView({ greeting: 'Hi' }))
```

Missing methods answer **405** with an `Allow` header; `HEAD` uses `get()`; `OPTIONS` answers with `Allow`.
Override `dispatch(c)` or `setup(c)` for cross-cutting logic, like Django.

`TemplateView` renders a Hono JSX component with `getContextData()`:

```tsx
class About extends TemplateView {
  template = (p: { title: string }) => (
    <html lang="en"><body><h1>{p.title}</h1></body></html>
  )
  async getContextData() {
    return { ...(await super.getContextData()), title: 'About us' }
  }
}
```

JSX output is escaped; use `html` from `hono/html` for trusted raw markup. `render()` adds
`<!DOCTYPE html>` when the output starts with `<html`.

`RedirectView.asView({ patternName: 'blog:list' })` or `{ url: '/posts/{id}/', permanent: true, queryString: true }`.

## Errors

Raise errors anywhere in a view; Ghuri maps them to responses:

| Error | Status |
|---|---|
| `Http404`, `ObjectDoesNotExist` | 404 |
| `PermissionDenied`, `CsrfFailure` | 403 |
| `BadRequest`, `SuspiciousOperation`, `DisallowedHost` | 400 |
| `ValidationError` | 400 with `{ detail, errors: { field: [messages] } }` |
| `MethodNotAllowed` | 405 with `Allow` |
| Hono `HTTPException` | its status / response |
| anything else | 500 |

Responses are JSON (`{ "detail": "…" }`) when the client accepts JSON but not HTML, sends JSON, or the
path is under `/api`; HTML otherwise. With `DEBUG`, 500s show a debug page with the stack trace,
request and (masked) settings, and 404s list the URL patterns that were tried — like Django.
Production pages never reveal details.

### Custom error pages (`HANDLER_404`, `HANDLER_500`)

Django's `handler404` / `handler500` are settings in Ghuri. Each is a view that gets the Hono context and
the exception and returns a Response:

```tsx
import { defineSettings, notFoundResponse, render, wantsJson } from '@ghuri/core'

export default defineSettings((env) => ({
  // …
  HANDLER_404: (c, exception) => {
    if (wantsJson(c)) return notFoundResponse(c) // keep the built-in JSON 404 for API clients
    return render(c, <NotFound tenant={c.get('tenant')} />, { status: 404 })
  },
  HANDLER_500: (c) => c.html('<h1>Something went wrong</h1>', 500),
}))
```

- `HANDLER_404` is called for paths no URL pattern matches, **after** the `APPEND_SLASH` redirect and the
  405 check for method-restricted routes (405s are never sent to it), and for `Http404` /
  `ObjectDoesNotExist` raised by views or middleware. For unmatched paths the exception is a
  `Resolver404`. It runs at the end of the middleware chain, inside the request context, so values set
  by `MIDDLEWARE` (the current tenant, the user, …) are available, and middleware still sees its response.
- `HANDLER_500` is called for uncaught exceptions — errors not mapped to a status (`PermissionDenied`,
  `ValidationError`, `HttpError` subclasses, Hono's `HTTPException` keep their default responses).
- Both are used for every client, HTML or JSON, like Django. Use `wantsJson(c)` and `notFoundResponse(c)`
  (the built-in 404, which never calls `HANDLER_404`) to keep JSON errors for API clients.
  `@ghuri/rest` views turn `Http404` into their own JSON `NotFound`, so they never reach it.
- With `DEBUG` on, they are not called: the technical 404 / 500 pages show instead, as in Django.
- If a handler throws (or returns something that is not a Response), the error is logged and the default
  404 / 500 page is used. (Django renders the 500 page when `handler404` fails.)
- Status codes are whatever the handler returns: pass `404` / `500` yourself.

Packages and projects can map their own errors:

```ts
registerExceptionHandler(MyError, (err, c) => c.json({ code: err.code }, 409))
// or per app: createApp(settings, { onError: (err, c) => … })
```

## Middleware

```ts
MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, CorsMiddleware, CsrfMiddleware, SessionMiddleware, AuthenticationMiddleware]
```

Write your own Django-style — it wraps the rest of the chain:

```ts
import { Middleware } from '@ghuri/core'

export class TimingMiddleware extends Middleware {
  async handle(c: Context, next: Next) {
    const started = Date.now()
    await next()
    c.header('Server-Timing', `app;dur=${Date.now() - started}`)
  }
}
```

Return a `Response` to short-circuit (before `next()`) or replace the response (after it).
`MIDDLEWARE` also accepts configured instances (`new CorsMiddleware({ allowOrigins: '*' })`) and plain
Hono middleware (`logger()`).

Built-ins:

- **`SecurityMiddleware`** — `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`,
  HSTS over https when `SECURE_HSTS_SECONDS > 0`, `SECURE_SSL_REDIRECT`.
- **`CommonMiddleware`** — `ALLOWED_HOSTS` (also enforced by the app itself), `PREPEND_WWW`, `APPEND_SLASH`.
- **`CorsMiddleware`** — uses the `CORS` setting; handles preflight requests.
- **`CsrfMiddleware`** — Django's CSRF protection: unsafe requests must send the `csrftoken` cookie's
  token in the `X-CSRFToken` header or the `csrfmiddlewaretoken` form field; `Origin` (and on https
  `Referer`) must match the host or `CSRF_TRUSTED_ORIGINS`. Tokens are Django-compatible (masked).
- **`XFrameOptionsMiddleware`** — `X-Frame-Options: DENY` (setting `X_FRAME_OPTIONS`). Exempt one view
  with `xframeOptionsExempt(view)` or `static xframeOptionsExempt = true`; a header the view sets is kept.
- **`GZipMiddleware`** — compression on Node; a no-op on Workers (Cloudflare compresses at the edge).

CSRF helpers:

```tsx
<input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken(c)} />

path('webhooks/stripe/', csrfExempt(stripeWebhook))   // also works on mounted Hono apps
path('embed/', xframeOptionsExempt(embedView))        // let other pages frame this view
```

Client address (Django's `REMOTE_ADDR`): `getRemoteAddr(c)` returns `CF-Connecting-IP` on Cloudflare and the socket
address on Node (`serve()` records it; custom servers call `setRemoteAddr(request, addr)`). It never reads
`X-Forwarded-For`.

```ts
path('spa/', ensureCsrfCookie(spaShell))              // always set the cookie
rotateCsrfToken(c)                                    // e.g. after login
await enforceCsrf(c)                                  // manual check (REST session auth)
```

## Request context

Every request runs inside an `AsyncLocalStorage` context, so settings, env and per-request state are
available without passing `c` around:

```ts
import { getContext, getEnv, getSettings, getUser } from '@ghuri/core'

const ctx = getContext()       // { env, settings, request, hono, executionCtx, state }
ctx.state.set(MY_KEY, value)   // per-request cache (the ORM keeps DB connections here)
ctx.executionCtx?.waitUntil(sendAnalytics())
getEnv().MY_BINDING
getUser(c)                     // RequestUser, AnonymousUser by default
```

The Hono context also carries it: `c.get('ghuri')`, and `c.get('user')` (typed via `ContextVariableMap`).
Outside requests (CLI, scripts, tests) call `await app.setup(env)` first, or wrap code in
`runWithContext(ctx, fn)`.

## Signals

```ts
import { Signal, receiver, requestStarted, requestFinished } from '@ghuri/core'

requestFinished.connect(async ({ request, response }) => { /* … */ })

export const orderPlaced = new Signal<{ order: Order }>('orderPlaced')
receiver(orderPlaced)(async ({ order, sender }) => sendReceipt(order))
await orderPlaced.send(OrderService, { order })
```

Receivers run sequentially and are awaited. `connect(fn, { sender, uid })`, `disconnect(fnOrUid)`.
The ORM adds `preSave`, `postSave`, `preDelete`, `postDelete`, `m2mChanged`.

## Cache

```ts
import { cache, caches, cfCache, kvCache, memoryCache } from '@ghuri/core'

CACHES: {
  default: kvCache('CACHE', { keyPrefix: 'v1' }), // Workers KV binding
  local: memoryCache({ timeout: 60 }),             // per isolate / process
  edge: cfCache(),                                 // Cloudflare Cache API (per data center)
}

await cache.set('greeting', { text: 'hi' }, 300)   // TTL seconds (default 300; null = forever)
await cache.get('greeting')                        // undefined when missing
await cache.getOrSet('stats', () => computeStats(), 60)
await cache.add('lock', true, 30)                  // only if missing
await cache.incr('hits')
await caches.get('local').clear()
```

Values are JSON-serialized. KV is eventually consistent and has a 60-second minimum TTL (shorter
TTLs are rounded up). Without `CACHES`, the default cache is in-memory. A cache config is just
`{ backend: string, create(env): CacheBackend }`, so custom backends are easy.

## Cron triggers and queues

`createApp()` also exports `scheduled` and `queue` handlers that dispatch to registered handlers,
inside a Ghuri context:

```ts
import { onQueue, onSchedule } from '@ghuri/core'

class BlogConfig extends AppConfig {
  name = 'blog'
  ready() {
    onSchedule('0 * * * *', async (event) => { await publishScheduledPosts() })  // or '*' for all crons
    onQueue<{ postId: number }>('emails', async (batch) => {
      for (const msg of batch.messages) { await sendEmail(msg.body); msg.ack() }
    })
  }
}
```

## Management commands

```ts
import { BaseCommand, type ArgumentParser, type CommandIO } from '@ghuri/core'

export class Greet extends BaseCommand {
  static help = 'Say hello'
  addArguments(parser: ArgumentParser) {
    parser.argument('name').option('--shout', { help: 'Use capitals' })
  }
  async handle(args: Record<string, unknown>, io: CommandIO) {
    const msg = `Hello ${args.name}`
    io.stdout(io.style.success(args.shout ? msg.toUpperCase() : msg))
  }
}

// in your AppConfig: commands = { greet: Greet }   →   npx ghuri greet World --shout
```

`callCommand('greet', { name: 'x' })` runs a command programmatically (`bufferIO()` captures output).

## System checks

```ts
import { checks, runChecks } from '@ghuri/core'

checks.register(({ settings }) =>
  settings.MY_FEATURE ? [] : [checks.warning('MY_FEATURE is not configured.', { id: 'myapp.W001' })],
)
const messages = await runChecks({ deploy: true })  // `ghuri check --deploy`
```

Checks run at startup when `DEBUG` is on; errors stop the app with a clear message. Built-in checks
cover URL patterns, middleware entries, and (with `deploy: true`) Django's security warnings.
Silence ids with `SILENCED_SYSTEM_CHECKS`.

## Running on Node

```ts
// src/server.ts
import { serve } from '@ghuri/core/node'
import { createApp } from '@ghuri/core'
import settings from './settings'

serve(createApp(settings), { port: 8000, env: process.env })
```

`serve()` uses `@hono/node-server` (install it), passes `env` to the app, provides a `waitUntil`
shim, and shuts down gracefully on SIGINT/SIGTERM.

## Testing

```ts
import { createTestClient } from '@ghuri/core/testing'
import app from '../src/index'

const client = createTestClient(app, { env: { SECRET_KEY: 'test', DEBUG: 'false' } })

const res = await client.post('/api/posts/', { json: { title: 'Hi' } })
expect(res.status).toBe(201)
expect(await res.json()).toMatchObject({ title: 'Hi' })

await client.get('/search/', { query: { q: 'ghuri' }, headers: { accept: 'text/html' } })
await client.post('/contact/', { form: { email: 'a@b.c', attachment: new File(['x'], 'x.txt') } })
const followed = await client.get('/old/', { follow: true }) // followed.redirectChain
await client.forceLogin(user)                                 // provided by @ghuri/auth
await client.withContext(async () => { /* ORM calls with the app's settings */ })
```

The client keeps cookies between requests and sends the CSRF token automatically on unsafe requests
(`csrf: false` to test CSRF failures). Requests go to `http://testserver` (change with `baseUrl`). It
is fetch-based, so it works in Node and in `@cloudflare/vitest-pool-workers`. Packages extend it
with `registerTestClientHook(name, fn)`.

## License

MIT
