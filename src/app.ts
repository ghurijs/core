import type { Context } from 'hono'
import { Hono } from 'hono'
import { apps } from './apps'
import { runChecks } from './checks'
import {
  createContext,
  type Env,
  type ExecutionContextLike,
  type GhuriContext,
  runWithContext,
  setGlobalContext,
} from './context'
import { ImproperlyConfigured } from './errors'
import { type ExceptionHandler, handleException, notFoundHandler } from './exceptions'
import { type MiddlewareEntry, toHonoMiddleware, validateHost } from './middleware'
import { defineSettings, type GhuriSettings, isSettingsFactory, type SettingsFactory } from './settings'
import { requestFinished, requestStarted } from './signals'
import { type MessageBatchLike, type ScheduledEventLike, taskHandlers } from './tasks'
import { getResolver, type UrlPatterns, type UrlResolver } from './urls'

export interface CreateAppOptions {
  /** Customize the Hono app. Called after MIDDLEWARE is installed and before the URL patterns. */
  hono?: (app: Hono) => void
  /** Custom error handling. Return a Response to override the default mapping, or undefined to fall through. */
  onError?: ExceptionHandler
  /** Run system checks when the app starts with DEBUG on (default true). */
  checks?: boolean
}

/** The object a Worker exports (`export default createApp(settings)`). */
export interface GhuriApp {
  fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response>
  /** Cron Triggers: dispatches to handlers registered with `onSchedule()`. */
  scheduled(event: ScheduledEventLike, env?: Env, ctx?: ExecutionContextLike): Promise<void>
  /** Queue consumer: dispatches to handlers registered with `onQueue()`. */
  queue(batch: MessageBatchLike, env?: Env, ctx?: ExecutionContextLike): Promise<void>
  /** Populate apps without a request and install a global context (CLI, scripts, tests). */
  setup(env?: Env): Promise<GhuriContext>
  /** The built Hono router (for testing / composition). Requests through it still get a Ghuri context. */
  hono(env?: Env): Promise<Hono>
}

interface Built {
  hono: Hono
  urlconf: UrlResolver
}

const EMPTY_ENV: Env = Object.freeze({}) as Env

function toFactory(
  settings: SettingsFactory | ((env: Env) => GhuriSettings) | GhuriSettings,
): SettingsFactory {
  if (isSettingsFactory(settings)) return settings
  if (typeof settings === 'function') return defineSettings(settings)
  if (settings && typeof settings === 'object') return defineSettings(() => settings)
  throw new ImproperlyConfigured('createApp() expects settings created with defineSettings().')
}

function safeExecutionCtx(c: Context): ExecutionContextLike | undefined {
  try {
    return c.executionCtx
  } catch {
    return undefined
  }
}

function reportChecks(messages: Awaited<ReturnType<typeof runChecks>>): void {
  if (!messages.length) return
  const serious = messages.filter((m) => m.isSerious())
  for (const m of messages) (m.isSerious() ? console.error : console.warn)(`System check: ${m.toString()}`)
  if (serious.length) {
    throw new ImproperlyConfigured(
      `System check identified ${serious.length} error(s):\n${serious.map((m) => m.toString()).join('\n')}`,
    )
  }
}

/**
 * Create the application (Django's `wsgi.py`). The returned object is a Workers module handler
 * (`fetch` / `scheduled` / `queue`) and also works with `serve()` from `@ghuri/core/node`.
 */
export function createApp(
  settingsInput: SettingsFactory | ((env: Env) => GhuriSettings) | GhuriSettings,
  options: CreateAppOptions = {},
): GhuriApp {
  const factory = toFactory(settingsInput)
  const builds = new WeakMap<GhuriSettings, Promise<Built>>()
  let app: GhuriApp

  const resolveSettings = (env: Env | undefined): GhuriSettings => factory(env ?? EMPTY_ENV)

  async function prepare(settings: GhuriSettings, env: Env): Promise<void> {
    const ctx = createContext({ env, settings })
    await runWithContext(ctx, async () => {
      await apps.populate(settings.INSTALLED_APPS)
      if (settings.DEBUG && options.checks !== false) reportChecks(await runChecks({ settings }))
    })
  }

  function buildHono(settings: GhuriSettings): Built {
    const urlconf = getResolver(settings.ROOT_URLCONF as UrlPatterns)
    const hono = new Hono()

    // 1. Per-request Ghuri context + request signals.
    hono.use('*', async (c, next) => {
      const ctx = createContext({
        env: c.env ?? EMPTY_ENV,
        settings,
        executionCtx: safeExecutionCtx(c),
        request: c.req.raw,
        hono: c,
      })
      c.set('ghuri', ctx)
      await runWithContext(ctx, async () => {
        await requestStarted.send(app, { request: c.req.raw })
        try {
          await next()
        } finally {
          try {
            await requestFinished.send(app, { request: c.req.raw, response: c.res })
          } catch (err) {
            console.error('requestFinished receiver failed:', err)
          }
        }
      })
    })
    // 2. ALLOWED_HOSTS.
    hono.use('*', async (_c, next) => {
      validateHost(_c)
      await next()
    })
    // 3. MIDDLEWARE, in order.
    for (const entry of settings.MIDDLEWARE ?? []) hono.use('*', toHonoMiddleware(entry as MiddlewareEntry))
    // 4. User customization, then URL patterns.
    options.hono?.(hono)
    urlconf.mount(hono)
    // 5. Error handling.
    hono.notFound(notFoundHandler(urlconf))
    hono.onError(async (err, c) => {
      if (options.onError) {
        const res = await options.onError(err, c)
        if (res instanceof Response) return res
      }
      return handleException(err, c)
    })
    return { hono, urlconf }
  }

  function getBuilt(settings: GhuriSettings, env: Env): Promise<Built> {
    let p = builds.get(settings)
    if (!p) {
      p = prepare(settings, env).then(() => buildHono(settings))
      p.catch(() => builds.delete(settings))
      builds.set(settings, p)
    }
    return p
  }

  function startupFailure(err: unknown, settings: GhuriSettings | undefined): Response {
    console.error('Ghuri failed to start:', err)
    const debug = settings?.DEBUG
    const body = debug
      ? `Ghuri failed to start.\n\n${(err as Error)?.stack ?? String(err)}`
      : 'Internal Server Error'
    return new Response(body, { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8' } })
  }

  async function withTaskContext<T>(
    env: Env | undefined,
    execCtx: ExecutionContextLike | undefined,
    fn: (ctx: GhuriContext) => Promise<T>,
  ): Promise<T> {
    const e = env ?? EMPTY_ENV
    const settings = resolveSettings(e)
    await getBuilt(settings, e)
    const ctx = createContext({ env: e, settings, executionCtx: execCtx })
    return runWithContext(ctx, () => fn(ctx))
  }

  app = {
    async fetch(request, env, ctx) {
      const e = env ?? EMPTY_ENV
      let settings: GhuriSettings | undefined
      let built: Built
      try {
        settings = resolveSettings(e)
        built = await getBuilt(settings, e)
      } catch (err) {
        return startupFailure(err, settings)
      }
      return built.hono.fetch(request, e, ctx as any)
    },

    async scheduled(event, env, ctx) {
      await withTaskContext(env, ctx, async (gctx) => {
        const handlers = taskHandlers.schedulesFor(event.cron)
        if (!handlers.length) console.warn(`No onSchedule() handler registered for cron '${event.cron}'.`)
        const errors: unknown[] = []
        for (const h of handlers) {
          try {
            await h(event, gctx)
          } catch (err) {
            console.error(`Scheduled handler for '${event.cron}' failed:`, err)
            errors.push(err)
          }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, `${errors.length} scheduled handlers failed.`)
      })
    },

    async queue(batch, env, ctx) {
      await withTaskContext(env, ctx, async (gctx) => {
        const handlers = taskHandlers.queuesFor(batch.queue)
        if (!handlers.length) {
          throw new ImproperlyConfigured(`No onQueue() handler registered for queue '${batch.queue}'.`)
        }
        for (const h of handlers) await h(batch, gctx)
      })
    },

    async setup(env) {
      const e = env ?? EMPTY_ENV
      const settings = resolveSettings(e)
      await getBuilt(settings, e)
      const ctx = createContext({ env: e, settings })
      setGlobalContext(ctx)
      return ctx
    },

    async hono(env) {
      const e = env ?? EMPTY_ENV
      return (await getBuilt(resolveSettings(e), e)).hono
    },
  }
  return app
}
