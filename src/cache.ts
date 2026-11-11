import { type Env, tryGetContext } from './context'
import { GhuriError, ImproperlyConfigured } from './errors'

/**
 * Storage backend for the cache. Values are already JSON strings; `ttlSeconds` is `null` for "never expire".
 */
export interface CacheBackend {
  get(key: string): Promise<string | null | undefined>
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>
  delete(key: string): Promise<void>
  has?(key: string): Promise<boolean>
  /** Remove every key starting with `prefix` (all keys when prefix is ''). */
  clear?(prefix: string): Promise<void>
}

/** Entry of the `CACHES` setting. Same pattern as database / storage configs. */
export interface CacheConfig {
  backend: string
  create(env: Env): CacheBackend
  /** Prepended to every key (Django's KEY_PREFIX). */
  keyPrefix?: string
  /** Default TTL in seconds when `set()` gets none (Django's TIMEOUT, default 300). `null` = forever. */
  timeout?: number | null
}

export interface CacheOptions {
  keyPrefix?: string
  timeout?: number | null
}

/** High-level cache API (Django's `cache`). Values are JSON-serialized. */
export class Cache {
  constructor(
    readonly backend: CacheBackend,
    private readonly keyPrefix = '',
    private readonly defaultTimeout: number | null = 300,
  ) {}

  makeKey(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}:${key}` : key
  }

  private ttl(ttl: number | null | undefined): number | null {
    return ttl === undefined ? this.defaultTimeout : ttl
  }

  async get<T = unknown>(key: string): Promise<T | undefined>
  async get<T = unknown>(key: string, fallback: T): Promise<T>
  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const raw = await this.backend.get(this.makeKey(key))
    if (raw === null || raw === undefined) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** Store `value` for `ttlSeconds` (default: the configured timeout; `null` = forever; `<= 0` deletes). */
  async set(key: string, value: unknown, ttlSeconds?: number | null): Promise<void> {
    const ttl = this.ttl(ttlSeconds)
    if (ttl !== null && ttl <= 0) return this.delete(key)
    if (value === undefined) throw new TypeError('Cannot cache undefined; use null or delete the key.')
    await this.backend.set(this.makeKey(key), JSON.stringify(value), ttl)
  }

  /** Set only if the key is missing. Returns true when stored. (Not atomic on KV / Cache API.) */
  async add(key: string, value: unknown, ttlSeconds?: number | null): Promise<boolean> {
    if (await this.has(key)) return false
    await this.set(key, value, ttlSeconds)
    return true
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.makeKey(key))
  }

  async has(key: string): Promise<boolean> {
    if (this.backend.has) return this.backend.has(this.makeKey(key))
    const raw = await this.backend.get(this.makeKey(key))
    return raw !== null && raw !== undefined
  }

  /** Return the cached value, or compute it (`fn` may be async), store and return it. */
  async getOrSet<T>(
    key: string,
    valueOrFn: T | (() => T | Promise<T>),
    ttlSeconds?: number | null,
  ): Promise<T> {
    const raw = await this.backend.get(this.makeKey(key))
    if (raw !== null && raw !== undefined) return JSON.parse(raw) as T
    const value = typeof valueOrFn === 'function' ? await (valueOrFn as () => T | Promise<T>)() : valueOrFn
    if (value !== undefined) await this.set(key, value, ttlSeconds)
    return value
  }

  async getMany<T = unknown>(keys: string[]): Promise<Record<string, T>> {
    const out: Record<string, T> = {}
    await Promise.all(
      keys.map(async (k) => {
        const v = await this.get<T>(k)
        if (v !== undefined) out[k] = v
      }),
    )
    return out
  }

  async setMany(values: Record<string, unknown>, ttlSeconds?: number | null): Promise<void> {
    await Promise.all(Object.entries(values).map(([k, v]) => this.set(k, v, ttlSeconds)))
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.delete(k)))
  }

  /** Add `delta` to a numeric value. Throws if the key is missing. (Not atomic on KV / Cache API.) */
  async incr(key: string, delta = 1): Promise<number> {
    const current = await this.get<number>(key)
    if (current === undefined) throw new GhuriError(`Key '${key}' not found.`)
    const next = Number(current) + delta
    await this.set(key, next, null)
    return next
  }

  async decr(key: string, delta = 1): Promise<number> {
    return this.incr(key, -delta)
  }

  /** Remove every key of this cache (with its key prefix). */
  async clear(): Promise<void> {
    if (!this.backend.clear) throw new GhuriError('This cache backend does not support clear().')
    await this.backend.clear(this.keyPrefix ? `${this.keyPrefix}:` : '')
  }
}

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

/** In-process cache (Django's LocMemCache). Per isolate on Workers; per process on Node. */
export function memoryCache(opts: CacheOptions & { maxEntries?: number } = {}): CacheConfig {
  let store: CacheBackend | undefined
  const max = opts.maxEntries ?? 10_000
  return {
    backend: 'memory',
    keyPrefix: opts.keyPrefix,
    timeout: opts.timeout,
    create() {
      if (store) return store
      const map = new Map<string, { value: string; expires: number | null }>()
      const live = (key: string) => {
        const e = map.get(key)
        if (!e) return undefined
        if (e.expires !== null && e.expires <= Date.now()) {
          map.delete(key)
          return undefined
        }
        return e
      }
      store = {
        async get(key) {
          return live(key)?.value
        },
        async set(key, value, ttl) {
          map.delete(key)
          if (map.size >= max) map.delete(map.keys().next().value as string)
          map.set(key, { value, expires: ttl === null ? null : Date.now() + ttl * 1000 })
        },
        async delete(key) {
          map.delete(key)
        },
        async has(key) {
          return live(key) !== undefined
        },
        async clear(prefix) {
          if (!prefix) return map.clear()
          for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k)
        },
      }
      return store
    },
  }
}

interface KVNamespaceLike {
  get(key: string, type?: 'text'): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: {
    prefix?: string
    cursor?: string
  }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>
}

/**
 * Workers KV cache. `binding` is the KV namespace binding name (or the namespace itself).
 * KV is eventually consistent and its minimum TTL is 60 seconds (shorter TTLs are rounded up).
 */
export function kvCache(binding: string | KVNamespaceLike, opts: CacheOptions = {}): CacheConfig {
  return {
    backend: 'kv',
    keyPrefix: opts.keyPrefix,
    timeout: opts.timeout,
    create(env) {
      const kv = (typeof binding === 'string' ? env[binding] : binding) as KVNamespaceLike | undefined
      if (!kv || typeof kv.get !== 'function') {
        throw new ImproperlyConfigured(`KV namespace binding '${String(binding)}' was not found in env.`)
      }
      return {
        async get(key) {
          return kv.get(key, 'text')
        },
        async set(key, value, ttl) {
          await kv.put(key, value, ttl === null ? undefined : { expirationTtl: Math.max(60, Math.ceil(ttl)) })
        },
        async delete(key) {
          await kv.delete(key)
        },
        async clear(prefix) {
          let cursor: string | undefined
          do {
            const page = await kv.list({ prefix, cursor })
            await Promise.all(page.keys.map((k) => kv.delete(k.name)))
            cursor = page.list_complete ? undefined : page.cursor
          } while (cursor)
        },
      }
    },
  }
}

/**
 * Cloudflare Cache API cache (`caches.default`, or a named cache). Per data center, best effort;
 * `clear()` is not supported.
 */
export function cfCache(opts: CacheOptions & { name?: string; baseUrl?: string } = {}): CacheConfig {
  const base = opts.baseUrl ?? 'https://ghuri-cache.internal/'
  return {
    backend: 'cf-cache',
    keyPrefix: opts.keyPrefix,
    timeout: opts.timeout,
    create() {
      const storage = (globalThis as any).caches
      if (!storage) throw new ImproperlyConfigured('cfCache() needs the Cache API (Cloudflare Workers).')
      const open = async (): Promise<any> =>
        opts.name ? storage.open(opts.name) : (storage.default ?? storage.open('default'))
      const url = (key: string) => `${base}${encodeURIComponent(key)}`
      return {
        async get(key) {
          const res = await (await open()).match(url(key))
          return res ? res.text() : undefined
        },
        async set(key, value, ttl) {
          const maxAge = ttl === null ? 31536000 : Math.max(1, Math.ceil(ttl))
          await (await open()).put(
            url(key),
            new Response(value, {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${maxAge}` },
            }),
          )
        },
        async delete(key) {
          await (await open()).delete(url(key))
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const DEFAULT_KEY = Symbol.for('ghuri.core.defaultCache')
const defaultConfig: CacheConfig = ((globalThis as any)[DEFAULT_KEY] ??= memoryCache())
const instances = new WeakMap<CacheConfig, WeakMap<object, Cache>>()
const NO_ENV = {}

function configFor(alias: string): CacheConfig {
  const caches = tryGetContext()?.settings.CACHES
  const cfg = caches?.[alias]
  if (cfg) return cfg
  if (alias === 'default') return defaultConfig
  throw new ImproperlyConfigured(`The cache alias '${alias}' is not configured in CACHES.`)
}

/** Access configured caches: `caches.get('sessions')`. */
export const caches = {
  get(alias = 'default'): Cache {
    const cfg = configFor(alias)
    const env = tryGetContext()?.env ?? NO_ENV
    let perEnv = instances.get(cfg)
    if (!perEnv) {
      perEnv = new WeakMap()
      instances.set(cfg, perEnv)
    }
    let c = perEnv.get(env)
    if (!c) {
      c = new Cache(cfg.create(env), cfg.keyPrefix ?? '', cfg.timeout === undefined ? 300 : cfg.timeout)
      perEnv.set(env, c)
    }
    return c
  },
}

/** The default cache (resolved per call from the current context's settings). */
export const cache = {
  get: <T = unknown>(key: string, fallback?: T): Promise<T | undefined> =>
    caches.get().get<T>(key, fallback as T),
  set: (key: string, value: unknown, ttlSeconds?: number | null) => caches.get().set(key, value, ttlSeconds),
  add: (key: string, value: unknown, ttlSeconds?: number | null) => caches.get().add(key, value, ttlSeconds),
  delete: (key: string) => caches.get().delete(key),
  has: (key: string) => caches.get().has(key),
  getOrSet: <T>(key: string, valueOrFn: T | (() => T | Promise<T>), ttlSeconds?: number | null) =>
    caches.get().getOrSet<T>(key, valueOrFn, ttlSeconds),
  getMany: <T = unknown>(keys: string[]) => caches.get().getMany<T>(keys),
  setMany: (values: Record<string, unknown>, ttlSeconds?: number | null) =>
    caches.get().setMany(values, ttlSeconds),
  deleteMany: (keys: string[]) => caches.get().deleteMany(keys),
  incr: (key: string, delta?: number) => caches.get().incr(key, delta),
  decr: (key: string, delta?: number) => caches.get().decr(key, delta),
  clear: () => caches.get().clear(),
}
