import type { GhuriContext } from './context'

/** Cloudflare `ScheduledController` (structural). */
export interface ScheduledEventLike {
  cron: string
  scheduledTime: number
  type?: string
  noRetry?(): void
}

/** Cloudflare Queues message (structural). */
export interface QueueMessageLike<T = unknown> {
  id: string
  timestamp: Date
  body: T
  attempts?: number
  ack(): void
  retry(opts?: { delaySeconds?: number }): void
}

/** Cloudflare Queues `MessageBatch` (structural). */
export interface MessageBatchLike<T = unknown> {
  queue: string
  messages: readonly QueueMessageLike<T>[]
  ackAll(): void
  retryAll(opts?: { delaySeconds?: number }): void
}

export type ScheduledHandler = (event: ScheduledEventLike, ctx: GhuriContext) => void | Promise<void>
export type QueueHandler<T = any> = (batch: MessageBatchLike<T>, ctx: GhuriContext) => void | Promise<void>

interface Registry {
  schedules: Array<{ cron: string; handler: ScheduledHandler }>
  queues: Array<{ queue: string; handler: QueueHandler }>
}

const KEY = Symbol.for('ghuri.core.tasks')
const registry: Registry = ((globalThis as any)[KEY] ??= { schedules: [], queues: [] })

/**
 * Run `handler` for Cron Triggers matching `cron` (the exact expression from wrangler.jsonc, or `'*'` for
 * every trigger). Typically called from an AppConfig's `ready()`. Returns an unregister function.
 */
export function onSchedule(cron: string, handler: ScheduledHandler): () => void {
  const entry = { cron, handler }
  registry.schedules.push(entry)
  return () => {
    registry.schedules = registry.schedules.filter((e) => e !== entry)
  }
}

/** Consume batches of the queue named `queue` (or `'*'` for all queues). Returns an unregister function. */
export function onQueue<T = any>(queue: string, handler: QueueHandler<T>): () => void {
  const entry = { queue, handler: handler as QueueHandler }
  registry.queues.push(entry)
  return () => {
    registry.queues = registry.queues.filter((e) => e !== entry)
  }
}

/** Introspection / test helpers for the cron & queue handler registry. */
export const taskHandlers = {
  schedulesFor(cron: string): ScheduledHandler[] {
    return registry.schedules.filter((e) => e.cron === cron || e.cron === '*').map((e) => e.handler)
  },
  queuesFor(queue: string): QueueHandler[] {
    return registry.queues.filter((e) => e.queue === queue || e.queue === '*').map((e) => e.handler)
  },
  clear(): void {
    registry.schedules = []
    registry.queues = []
  },
}
