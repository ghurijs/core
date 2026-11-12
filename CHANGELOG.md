# Changelog

## 0.1.0-alpha.3

- `xframeOptionsExempt(view)` (Django's `xframe_options_exempt`) and `static xframeOptionsExempt = true`
  on class views: `XFrameOptionsMiddleware` adds no `X-Frame-Options` header to that view's responses, so
  it can be framed (e.g. a preview inside a dashboard). Works on function views, `asView()` views and
  mounted Hono apps, like `csrfExempt`. A header the view sets itself is still kept, exempt or not.
  `isXFrameOptionsExempt(c)` and `XFRAME_OPTIONS_EXEMPT_MARKER` are exported for other packages.
- `getRemoteAddr(c)` (Django's `REMOTE_ADDR`): the client address from sources a client cannot forge —
  `CF-Connecting-IP` on Cloudflare, else the socket address on Node, else `''`. `serve()` from `@ghuri/core/node`
  now records each request's socket address (`env` is unchanged); custom servers (Bun, Deno) can call
  `setRemoteAddr(request, addr)` before `app.fetch()`. `X-Forwarded-For` is not read: behind a reverse proxy this is
  the proxy's address. Also exported: `isCloudflareRequest(c)`.

## 0.1.0-alpha.2

- `HANDLER_404` and `HANDLER_500` settings (Django's `handler404` / `handler500`): custom error views
  `(c, exception) => Response`. `HANDLER_404` renders unmatched paths, after the `APPEND_SLASH` redirect
  and the 405 check, and `Http404` / `ObjectDoesNotExist` raised by views; `HANDLER_500` renders uncaught
  exceptions. Both run inside the request context after `MIDDLEWARE`, are skipped with `DEBUG` on (the
  technical pages show, like Django), and fall back to the default page if they throw. Projects no longer
  need a catch-all `<path:rest>` route (which disabled `APPEND_SLASH` and 405s) for a custom 404 page.
  Non-function values raise `ImproperlyConfigured`.

## 0.1.0-alpha.1

- `app.run(env, executionCtx, fn)`: run work that does not arrive through `fetch` (Durable Object events,
  WebSocket messages, scripts) in a fresh Ghuri context with apps populated, like `scheduled`/`queue` do.
  Unlike `setup()` it installs no global context. Used by `@ghuri/realtime`.
- `registerUserLoader(fn)` / `loadUser(pk)`: load a user by primary key without importing `@ghuri/auth`
  (which registers the loader). Used by WebSocket consumers that only keep the user's pk.

## 0.1.0-alpha.0

- Settings (`defineSettings`, `getSettings`, `setting`), app registry (`AppConfig`, `apps`), request
  context (`runWithContext`, `getContext`, `setGlobalContext`), signals, errors, request user contract.
- URLs: `path()`, `rePath()`, `include()` with namespaces, `urlpatterns(appName, …)`, Django converters
  compiled to Hono patterns, `registerConverter()`, `reverse()`, `resolve()`, `kwargs(c)`, `resolverMatch(c)`,
  mounting Hono apps.
- Views: `View` (`asView`, `dispatch`, 405 + `Allow`, HEAD/OPTIONS), `TemplateView` (Hono JSX),
  `RedirectView`, shortcuts `json()`, `redirect()`, `render()`, `resolveUrl()`.
- Error handling: HTTP errors / `ValidationError` / `ObjectDoesNotExist` → JSON or HTML responses,
  DEBUG technical 500 and 404 pages, `registerExceptionHandler()`.
- Middleware: `Middleware` base class, `SecurityMiddleware`, `CommonMiddleware`, `CorsMiddleware`,
  `CsrfMiddleware` (+ `csrfExempt`, `ensureCsrfCookie`, `getCsrfToken`, `rotateCsrfToken`, `enforceCsrf`),
  `XFrameOptionsMiddleware`, `GZipMiddleware`.
- `createApp()` with `fetch` / `scheduled` / `queue` / `setup` / `hono`; `onSchedule()` / `onQueue()`.
- Cache: `cache`, `caches`, `memoryCache()`, `kvCache()`, `cfCache()`.
- System checks: `checks.register()`, `runChecks()`.
- Management command base classes and registry; `AppConfig.commands` are registered on populate.
- `@ghuri/core/node`: `serve()`. `@ghuri/core/testing`: `createTestClient()`, `registerTestClientHook()`.
