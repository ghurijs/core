import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Cache,
  type CacheBackend,
  cache,
  caches,
  cfCache,
  createContext,
  ImproperlyConfigured,
  kvCache,
  memoryCache,
  runWithContext,
} from '../src/index'

function fakeKV() {
  const data = new Map<string, { value: string; ttl?: number }>()
  return {
    data,
    async get(key: string) {
      return data.get(key)?.value ?? null
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      data.set(key, { value, ttl: opts?.expirationTtl })
    },
    async delete(key: string) {
      data.delete(key)
    },
    async list(opts: { prefix?: string } = {}) {
      return {
        keys: [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).map((name) => ({ name })),
        list_complete: true,
      }
    },
  }
}

function withSettings<T>(
  caches: Record<string, unknown> | undefined,
  env: Record<string, unknown>,
  fn: () => T,
): T {
  const ctx = createContext({
    env,
    settings: { SECRET_KEY: 'x', INSTALLED_APPS: [], ROOT_URLCONF: [], CACHES: caches as any },
  })
  return runWithContext(ctx, fn)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('memoryCache', () => {
  it('stores JSON values with TTL', async () => {
    vi.useFakeTimers()
    const c = new Cache(memoryCache().create({}))
    await c.set('a', { n: 1, list: [1, 2] }, 10)
    const v = await c.get<{ n: number }>('a')
    expect(v).toEqual({ n: 1, list: [1, 2] })
    v!.n = 99
    expect(await c.get('a')).toEqual({ n: 1, list: [1, 2] }) // values are copies
    expect(await c.has('a')).toBe(true)
    vi.advanceTimersByTime(10_001)
    expect(await c.get('a')).toBeUndefined()
    expect(await c.get('a', 'fallback')).toBe('fallback')
  })

  it('supports default timeout, null (forever), 0 (delete) and null values', async () => {
    vi.useFakeTimers()
    const c = new Cache(memoryCache().create({}), '', 5)
    await c.set('d', 1)
    await c.set('forever', 2, null)
    await c.set('nil', null)
    expect(await c.get('nil')).toBeNull()
    expect(await c.has('nil')).toBe(true)
    vi.advanceTimersByTime(6000)
    expect(await c.get('d')).toBeUndefined()
    expect(await c.get('forever')).toBe(2)
    await c.set('forever', 3, 0)
    expect(await c.has('forever')).toBe(false)
    await expect(c.set('u', undefined)).rejects.toThrow(TypeError)
  })

  it('getOrSet, add, many, incr/decr, clear with prefix', async () => {
    const backend = memoryCache().create({})
    const c = new Cache(backend, 'p')
    const other = new Cache(backend, 'q')
    const fn = vi.fn(async () => 'computed')
    expect(await c.getOrSet('k', fn)).toBe('computed')
    expect(await c.getOrSet('k', fn)).toBe('computed')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(await c.add('k', 'other')).toBe(false)
    expect(await c.add('new', 'v')).toBe(true)
    await c.setMany({ x: 1, y: 2 })
    expect(await c.getMany(['x', 'y', 'z'])).toEqual({ x: 1, y: 2 })
    expect(await c.incr('x', 5)).toBe(6)
    expect(await c.decr('x')).toBe(5)
    await expect(c.incr('missing')).rejects.toThrow(/not found/)
    await other.set('keep', true)
    await c.clear()
    expect(await c.get('x')).toBeUndefined()
    expect(await other.get('keep')).toBe(true)
    await c.deleteMany(['nothing'])
  })

  it('evicts the oldest entry beyond maxEntries', async () => {
    const c = new Cache(memoryCache({ maxEntries: 2 }).create({}))
    await c.set('a', 1)
    await c.set('b', 2)
    await c.set('c', 3)
    expect(await c.get('a')).toBeUndefined()
    expect(await c.get('c')).toBe(3)
  })
})

describe('kvCache', () => {
  it('uses the env binding, rounds TTLs up to 60s and clears by prefix', async () => {
    const kv = fakeKV()
    const cfg = kvCache('CACHE', { keyPrefix: 'app' })
    await withSettings({ default: cfg }, { CACHE: kv }, async () => {
      await cache.set('a', { x: 1 }, 5)
      await cache.set('b', 1, null)
      expect(kv.data.get('app:a')).toEqual({ value: '{"x":1}', ttl: 60 })
      expect(kv.data.get('app:b')?.ttl).toBeUndefined()
      expect(await cache.get('a')).toEqual({ x: 1 })
      await kv.put('unrelated', '1')
      await cache.clear()
      expect([...kv.data.keys()]).toEqual(['unrelated'])
    })
  })

  it('throws when the binding is missing', () => {
    expect(() => kvCache('NOPE').create({})).toThrow(ImproperlyConfigured)
  })
})

describe('cfCache', () => {
  it('stores responses in the Cache API', async () => {
    const store = new Map<string, Response>()
    const fake = {
      async match(url: string) {
        return store.get(url)?.clone()
      },
      async put(url: string, res: Response) {
        store.set(url, res)
      },
      async delete(url: string) {
        return store.delete(url)
      },
    }
    vi.stubGlobal('caches', { default: fake, open: async () => fake })
    const c = new Cache(cfCache().create({}))
    await c.set('k', [1, 2], 30)
    const [url, res] = [...store.entries()][0]
    expect(url).toBe('https://ghuri-cache.internal/k')
    expect(res.headers.get('cache-control')).toBe('max-age=30')
    expect(await c.get('k')).toEqual([1, 2])
    await c.delete('k')
    expect(await c.get('k')).toBeUndefined()
    await expect(c.clear()).rejects.toThrow(/does not support/)
    vi.unstubAllGlobals()
  })
})

describe('caches registry', () => {
  it('falls back to an in-memory default and reuses instances', async () => {
    const a = caches.get()
    expect(caches.get()).toBe(a)
    await cache.set('global', 1)
    expect(await cache.get('global')).toBe(1)
  })

  it('resolves aliases from settings', async () => {
    const sessions = memoryCache({ keyPrefix: 's' })
    await withSettings({ default: memoryCache(), sessions }, {}, async () => {
      await caches.get('sessions').set('x', 1)
      expect(caches.get('sessions').makeKey('x')).toBe('s:x')
      expect(await caches.get('default').get('x')).toBeUndefined()
      expect(() => caches.get('missing')).toThrow(/not configured/)
    })
  })

  it('accepts custom backends', async () => {
    const calls: string[] = []
    const backend: CacheBackend = {
      async get(k) {
        calls.push(`get ${k}`)
        return '"v"'
      },
      async set(k) {
        calls.push(`set ${k}`)
      },
      async delete() {},
    }
    await withSettings({ default: { backend: 'custom', create: () => backend } }, {}, async () => {
      expect(await cache.get('a')).toBe('v')
      expect(await cache.has('a')).toBe(true)
      await cache.set('b', 1)
    })
    expect(calls).toEqual(['get a', 'get a', 'set b'])
  })
})
