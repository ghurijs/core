// @ghuri/core/node — run a Ghuri app on Node.js (VPS, containers, local dev without wrangler).
import type { Env, ExecutionContextLike } from './context'
import { setRemoteAddr } from './remote'

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
  if (opts.handleSignals !== false) {
    const shutdown = () => {
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
