/**
 * Context carriers: request-scoped state (the current tenant, a locale…) that work leaving the request has to take
 * along. A package registers a carrier once; code that hands work to a queue, another service or a background
 * task calls `captureContext()` and later `restoreContext(captured, fn)`, without importing those packages.
 *
 * ```ts
 * const ctx = captureContext()            // { tenant: '42' } inside a tenant's request, {} otherwise
 * await queue.send({ ...job, context: ctx })
 * // consumer
 * await restoreContext(job.context, () => runJob(job))
 * ```
 */

/** Captured values, keyed by carrier name. JSON-safe, so they can go into a queue message or HTTP headers. */
export type CapturedContext = Record<string, string>

export interface ContextCarrier {
  /** Unique key in the captured object (`'tenant'`). */
  name: string
  /** The value of the current context as a string, or `undefined` when there is nothing to carry. */
  capture(): string | undefined
  /** Run `fn` with `value` (from `capture()`) active again. */
  restore<R>(value: string, fn: () => Promise<R>): Promise<R>
}

const KEY = Symbol.for('ghuri.core.contextCarriers')
const g = globalThis as any
// One registry per process, even if the module is loaded twice.
const carriers: Map<string, ContextCarrier> = (g[KEY] ??= new Map<string, ContextCarrier>())

/** Register (or replace) a carrier. Packages call this at import time. */
export function registerContextCarrier(carrier: ContextCarrier): void {
  carriers.set(carrier.name, carrier)
}

export function unregisterContextCarrier(name: string): boolean {
  return carriers.delete(name)
}

/** Names of the registered carriers. */
export function getContextCarriers(): string[] {
  return [...carriers.keys()]
}

/** The values every registered carrier has in the current context (carriers with nothing to carry are left out). */
export function captureContext(): CapturedContext {
  const out: CapturedContext = {}
  for (const c of carriers.values()) {
    const v = c.capture()
    if (typeof v === 'string' && v !== '') out[c.name] = v
  }
  return out
}

/**
 * Run `fn` with a captured context active again. Keys without a registered carrier are ignored, and an empty or
 * missing `captured` runs `fn` as is, so messages written before a carrier existed keep working.
 */
export async function restoreContext<R>(
  captured: CapturedContext | null | undefined,
  fn: () => Promise<R> | R,
): Promise<R> {
  const entries = Object.entries(captured ?? {}).filter(
    ([name, v]) => carriers.has(name) && typeof v === 'string' && v !== '',
  )
  const run = entries.reduceRight<() => Promise<R>>(
    (next, [name, value]) =>
      () =>
        carriers.get(name)!.restore(value, next),
    async () => fn(),
  )
  return run()
}
