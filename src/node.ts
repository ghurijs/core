// @ghuri/core/node — run a Ghuri app on Node.js (VPS, containers, local dev without wrangler).
import type { Env, ExecutionContextLike } from './context'
import { type CronExpression, parseCron } from './cron'
import { setRemoteAddr } from './remote'
import { type ScheduledEventLike, taskHandlers } from './tasks'

/** Anything with a Workers-style `fetch(request, env, ctx)` — a GhuriApp or a Hono app. */
export interface FetchApp {
  fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Response | Promise<Response>
}

export interface ServeOptions {
  /** Default: `process.env.PORT` or 8000. */
  port?: number
  /** Default: '0.0.0.0' (all interfaces) — use '127.0.0.1' for local only. */
  hostname?: string
  /** Passed to `app.fetch()` as `env` (settings read it). Default: `process.env`. */
  env?: Env
  /** Called once the server is listening. Default: logs the address. */
  onListen?(info: { address: string; port: number; family?: string }): void
  /** Close the server gracefully on SIGINT/SIGTERM (default true). */
  handleSignals?: boolean
  /**
   * Also fire the app's Cron Triggers in this process (`startScheduler()`), like `wrangler dev` does with
   * `--test-scheduled` and Cloudflare does in production. Run the scheduler in exactly one process.
   */
  scheduler?: boolean | Omit<SchedulerOptions, 'env'>
}

/** A Workers-like ExecutionContext for Node: `waitUntil` promises are tracked and their errors logged. */
export function createExecutionContext(): ExecutionContextLike & {
  pending: Set<Promise<unknown>>
  drain(): Promise<void>
} {
  const pending = new Set<Promise<unknown>>()
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      const p = Promise.resolve(promise)
        .catch((err) => console.error('waitUntil task failed:', err))
        .finally(() => pending.delete(p))
      pending.add(p)
    },
    passThroughOnException() {},
    async drain() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}

/**
 * Serve a Ghuri app with `@hono/node-server`:
 *
 * ```ts
 * import { serve } from '@ghuri/core/node'
 * serve(createApp(settings), { port: 8000, env: process.env })
 * ```
 */
export async function serve(app: FetchApp, opts: ServeOptions = {}) {
  const { serve: nodeServe } = await import('@hono/node-server')
  const env = opts.env ?? (process.env as Env)
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8000)
  const hostname = opts.hostname ?? '0.0.0.0'
  const execution = createExecutionContext()
  const server = nodeServe(
    {
      fetch: (request: Request, bindings?: any) => {
        // env stays the settings env; the socket address is exposed through getRemoteAddr(c)
        const addr = bindings?.incoming?.socket?.remoteAddress
        if (typeof addr === 'string' && addr) setRemoteAddr(request, addr)
        return app.fetch(request, env, execution)
      },
      port,
      hostname,
    },
    (info) => {
      if (opts.onListen) opts.onListen(info)
      else
        console.log(
          `Ghuri server listening on http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${info.port}/`,
        )
    },
  )
  const scheduler =
    opts.scheduler && typeof (app as Partial<SchedulableApp>).scheduled === 'function'
      ? await startScheduler(app as unknown as SchedulableApp, {
          ...(typeof opts.scheduler === 'object' ? opts.scheduler : {}),
          env,
        })
      : null
  if (opts.handleSignals !== false) {
    const shutdown = () => {
      void scheduler?.stop()
      server.close(() => {
        execution.drain().finally(() => process.exit(0))
      })
      setTimeout(() => process.exit(0), 10_000).unref()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }
  return server
}

/** An app with Workers' `scheduled()` handler (a `GhuriApp`). */
export interface SchedulableApp {
  scheduled(event: ScheduledEventLike, env?: Env, ctx?: ExecutionContextLike): Promise<void>
  /** Populates the app registry so `onSchedule()` handlers registered in `ready()` are known. */
  run?<T>(
    env: Env | undefined,
    ctx: ExecutionContextLike | undefined,
    fn: (ctx: any) => Promise<T>,
  ): Promise<T>
}

export interface SchedulerOptions {
  /** Cron expressions to fire (default: every cron registered with `onSchedule()`, read after the apps load). */
  crons?: string[]
  /** Passed to `app.scheduled()` as `env`. Default: `process.env`. */
  env?: Env
  /** Called when a scheduled handler throws (default: logs it). The scheduler keeps running. */
  onError?(error: unknown, cron: string): void
  /** Called once with the crons being fired (default: logs them). */
  onStart?(crons: string[]): void
}

export interface Scheduler {
  readonly crons: string[]
  /** Stop firing and wait for running handlers. */
  stop(): Promise<void>
}

/**
 * Fire a Ghuri app's Cron Triggers on Node with Cloudflare's semantics (UTC, 1 = Sunday; see `parseCron`): at
 * each matching minute, `app.scheduled({ cron, scheduledTime })` runs, so `onSchedule()` handlers and
 * `@ghuri/tasks` periodic tasks work outside Workers. Like Celery beat, run it in exactly one process.
 */
export async function startScheduler(app: SchedulableApp, opts: SchedulerOptions = {}): Promise<Scheduler> {
  const env = opts.env ?? (process.env as Env)
  if (!opts.crons && typeof app.run === 'function') await app.run(env, undefined, async () => undefined)
  const crons = opts.crons ?? taskHandlers.crons()
  const parsed: CronExpression[] = crons.map((c) => parseCron(c))
  const execution = createExecutionContext()
  const running = new Set<Promise<void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastMinute = Math.floor(Date.now() / 60_000)

  const fire = (minute: number) => {
    const at = new Date(minute * 60_000)
    for (const cron of parsed) {
      if (!cron.matches(at)) continue
      const event: ScheduledEventLike = {
        cron: cron.source,
        scheduledTime: at.getTime(),
        type: 'scheduled',
        noRetry() {},
      }
      const p = app
        .scheduled(event, env, execution)
        .catch((err) =>
          opts.onError ? opts.onError(err, cron.source) : console.error(`Cron '${cron.source}' failed:`, err),
        )
        .finally(() => running.delete(p))
      running.add(p)
    }
  }

  const tick = () => {
    if (stopped) return
    const minute = Math.floor(Date.now() / 60_000)
    // Fire every minute boundary crossed since the last tick (at most a few after a sleep / clock jump).
    for (let m = Math.max(lastMinute + 1, minute - 5); m <= minute; m++) fire(m)
    lastMinute = Math.max(lastMinute, minute)
    const delay = (minute + 1) * 60_000 - Date.now() + 50
    timer = setTimeout(tick, Math.max(delay, 50))
  }

  if (parsed.length) {
    if (opts.onStart) opts.onStart(crons)
    else console.log(`Ghuri scheduler: ${crons.map((c) => `'${c}'`).join(', ')} (UTC)`)
    timer = setTimeout(tick, (lastMinute + 1) * 60_000 - Date.now() + 50)
  }

  return {
    crons,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await Promise.all([...running])
      await execution.drain()
    },
  }
}
