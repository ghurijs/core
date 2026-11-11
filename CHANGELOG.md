# Changelog

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
