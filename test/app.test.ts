import type { Context } from 'hono'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppConfig,
  apps,
  BadRequest,
  createApp,
  defineSettings,
  getContext,
  getEnv,
  getSettings,
  getUser,
  Http404,
  loadUser,
  ObjectDoesNotExist,
  onQueue,
  onSchedule,
  PermissionDenied,
  path,
  registerUserLoader,
  requestFinished,
  requestStarted,
  reverse,
  setUser,
  taskHandlers,
  tryGetContext,
  ValidationError,
} from '../src/index'
import { createTestClient } from '../src/testing'

const events: string[] = []

class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  ready() {
    events.push(`ready:${this.appLabel}`)
  }
}

class ShopConfig extends AppConfig {
  name = 'apps.shop'
  async ready() {
    await Promise.resolve()
    events.push(`ready:${this.appLabel}:${getSettings().SITE_NAME}`)
  }
}

const STATE_KEY = Symbol('test')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const legacy = new Hono()
legacy.get('/hello', (c) => c.text(`legacy ${tryGetContext()?.settings.SITE_NAME}`))

const urls = [
  path('', (c) => c.text('home'), { name: 'home' }),
  path(
    'ctx/<int:id>/',
    async (c) => {
      const ctx = getContext()
      ctx.state.set(STATE_KEY, c.req.param('id'))
      await sleep(Number(c.req.query('delay') ?? 0))
      return c.json({
        id: ctx.state.get(STATE_KEY),
        same: c.get('ghuri') === ctx && ctx.hono === c,
        env: getEnv().FLAVOR,
        setting: getSettings().SITE_NAME,
        url: reverse('ctx', { id: 1 }),
        user: getUser(c).isAnonymous,
      })
    },
    { name: 'ctx' },
  ),
  path('user/', (c) => {
    setUser(c, { pk: 1, isAuthenticated: true, isAnonymous: false, hasPerm: async () => true })
    return c.json({ pk: getUser().pk, viaHono: c.get('user').pk })
  }),
  path('errors/404/', () => {
    throw new Http404('No such post')
  }),
  path('errors/403/', () => {
    throw new PermissionDenied()
  }),
  path('errors/400/', () => {
    throw new BadRequest('bad thing')
  }),
  path('errors/dne/', () => {
    throw new ObjectDoesNotExist('Post matching query does not exist.')
  }),
  path('errors/validation/', () => {
    throw new ValidationError({ title: ['This field is required.'] })
  }),
  path('errors/boom/', () => {
    throw new Error('kaboom')
  }),
  path('errors/response/', (c) => {
    throw c.text('thrown response', 418)
  }),
  path('errors/undefined/', (() => undefined) as any),
  path('posts/', (c) => c.text('posts'), { name: 'posts' }),
  path('only-get/', (c) => c.text('ok'), { methods: ['GET'] }),
  path('legacy/', legacy),
]

function makeSettings(debug: boolean, extra: Record<string, unknown> = {}) {
  return defineSettings((env) => ({
    SECRET_KEY: 'secret-key',
    DEBUG: debug,
    SITE_NAME: env.SITE ?? 'Ghuri',
    INSTALLED_APPS: [BlogConfig, ShopConfig],
    ROOT_URLCONF: urls,
    ...extra,
  }))
}

const app = createApp(makeSettings(false))
const client = createTestClient(app, { env: { FLAVOR: 'vanilla', SITE: 'Test Site' } })

afterEach(() => {
  taskHandlers.clear()
})

describe('createApp', () => {
  it('populates apps once and calls ready() in order with settings available', async () => {
    await client.get('/')
    await client.get('/')
    expect(apps.ready).toBe(true)
    expect(apps.getAppConfigs().map((a) => a.appLabel)).toEqual(['blog', 'shop'])
    expect(events).toEqual(['ready:blog', 'ready:shop:Test Site'])
    expect(apps.getAppConfig('blog').displayName).toBe('Blog')
  })

  it('runs every request in its own context', async () => {
    const res = await client.get('/ctx/5/')
    expect(await res.json()).toEqual({
      id: '5',
      same: true,
      env: 'vanilla',
      setting: 'Test Site',
      url: '/ctx/1/',
      user: true,
    })
  })

  it('keeps context state isolated across concurrent requests', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((id) =>
        client.get(`/ctx/${id}/`, { query: { delay: (7 - id) * 5 } }).then((r) => r.json()),
      ),
    )
    expect(results.map((r: any) => r.id)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('supports per-request users', async () => {
    expect(await (await client.get('/user/')).json()).toEqual({ pk: 1, viaHono: 1 })
  })

  it('loads users by pk through the registered loader', async () => {
    expect(await loadUser(1)).toBeNull()
    const user = { pk: 7, isAuthenticated: true, isAnonymous: false, hasPerm: async () => true }
    registerUserLoader(async (pk) => (pk === 7 ? user : null))
    try {
      expect(await loadUser(7)).toBe(user)
      expect(await loadUser(8)).toBeNull()
      expect(await loadUser(null)).toBeNull()
    } finally {
      registerUserLoader(undefined)
    }
  })

  it('sends request signals', async () => {
    const seen: string[] = []
    const started = ({ request }: { request: Request }) => {
      seen.push(`start ${new URL(request.url).pathname} ${!!tryGetContext()?.request}`)
    }
    const finished = ({ response }: { response?: Response }) => {
      seen.push(`finish ${response?.status}`)
    }
    requestStarted.connect(started)
    requestFinished.connect(finished)
    await client.get('/posts/')
    requestStarted.disconnect(started)
    requestFinished.disconnect(finished)
    expect(seen).toEqual(['start /posts/ true', 'finish 200'])
  })

  it('mounts Hono apps inside the context', async () => {
    expect(await (await client.get('/legacy/hello')).text()).toBe('legacy Test Site')
  })

  it('APPEND_SLASH redirects GET/HEAD to the slashed URL', async () => {
    const res = await client.get('/posts', { query: { a: 1 } })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/?a=1')
    expect((await client.head('/posts')).status).toBe(301)
    expect((await client.post('/posts')).status).toBe(404)
    expect((await client.get('/nothing')).status).toBe(404)
    const followed = await client.get('/posts', { follow: true })
    expect(await followed.text()).toBe('posts')
    expect(followed.redirectChain).toEqual([['/posts/', 301]])
  })

  it('APPEND_SLASH can be disabled', async () => {
    const c2 = createTestClient(createApp(makeSettings(false, { APPEND_SLASH: false })))
    expect((await c2.get('/posts')).status).toBe(404)
  })

  it('answers 405 for method-restricted routes', async () => {
    const res = await client.post('/only-get/', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect((await client.head('/only-get/')).status).toBe(200)
  })

  it('exposes setup() and hono()', async () => {
    const ctx = await app.setup({ SITE: 'CLI' })
    expect(getSettings().SITE_NAME).toBe('CLI')
    expect(ctx.state).toBeInstanceOf(Map)
    const hono = await app.hono({ SITE: 'Direct' })
    const res = await hono.request('/ctx/2/')
    expect((await res.json()).setting).toBe('Direct')
  })

  it('runs work outside requests in a fresh context with run()', async () => {
    const waited: Promise<unknown>[] = []
    const execCtx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) }
    const seen = await app.run({ SITE: 'Room' }, execCtx, async (ctx) => {
      expect(getContext()).toBe(ctx)
      expect(ctx.executionCtx).toBe(execCtx)
      return getSettings().SITE_NAME
    })
    expect(seen).toBe('Room')
    const [a, b] = await Promise.all([
      app.run({ SITE: 'A' }, undefined, async (ctx) => ctx.state),
      app.run({ SITE: 'B' }, undefined, async (ctx) => ctx.state),
    ])
    expect(a).not.toBe(b)
  })
})

describe('error handling (production)', () => {
  it('renders HTML errors without details', async () => {
    const res = await client.get('/errors/boom/')
    expect(res.status).toBe(500)
    const html = await res.text()
    expect(html).toContain('500 Server Error')
    expect(html).not.toContain('kaboom')
  })

  it('maps errors to JSON for API clients', async () => {
    const opts = { headers: { accept: 'application/json' } }
    const cases: Array<[string, number, unknown]> = [
      ['/errors/404/', 404, { detail: 'No such post' }],
      ['/errors/403/', 403, { detail: 'Permission denied.' }],
      ['/errors/400/', 400, { detail: 'bad thing' }],
      ['/errors/dne/', 404, { detail: 'Not found.' }],
      [
        '/errors/validation/',
        400,
        { detail: 'Invalid input.', errors: { title: ['This field is required.'] } },
      ],
      ['/errors/boom/', 500, { detail: 'Internal Server Error' }],
      ['/missing/', 404, { detail: 'Not found.' }],
    ]
    for (const [url, status, body] of cases) {
      const res = await client.get(url, opts)
      expect(res.status, url).toBe(status)
      expect(await res.json(), url).toEqual(body)
    }
  })

  it('treats /api paths as JSON', async () => {
    const res = await client.get('/api/nothing/')
    expect(res.headers.get('content-type')).toMatch(/json/)
  })

  it('returns thrown Responses and rejects views that return nothing', async () => {
    const res = await client.get('/errors/response/')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('thrown response')
    expect((await client.get('/errors/undefined/')).status).toBe(500)
  })
})

describe('error handling (DEBUG)', () => {
  const debugClient = createTestClient(createApp(makeSettings(true)))

  it('shows a technical 500 page with the stack and masked settings', async () => {
    const res = await debugClient.get('/errors/boom/', { headers: { accept: 'text/html' } })
    const html = await res.text()
    expect(res.status).toBe(500)
    expect(html).toContain('Error at /errors/boom/')
    expect(html).toContain('kaboom')
    expect(html).toContain('Traceback')
    expect(html).toContain('SECRET_KEY')
    expect(html).not.toContain('secret-key')
  })

  it('includes the stack in JSON', async () => {
    const body = await (
      await debugClient.get('/api/../errors/boom/', { headers: { accept: 'application/json' } })
    ).json()
    expect(body.detail).toBe('kaboom')
    expect(body.stack.length).toBeGreaterThan(1)
  })

  it('lists URL patterns on 404', async () => {
    const res = await debugClient.get('/nope/', { headers: { accept: 'text/html' } })
    const html = await res.text()
    expect(res.status).toBe(404)
    expect(html).toContain('Ghuri tried these URL patterns')
    expect(html).toContain('ctx/&lt;int:id&gt;/')
    expect(html).toContain("[name='ctx']")
    const json = await (await debugClient.get('/nope/', { headers: { accept: 'application/json' } })).json()
    expect(json.tried).toContain("posts/ [name='posts']")
  })

  it('shows the raising view for Http404 from views', async () => {
    const html = await (await debugClient.get('/errors/404/', { headers: { accept: 'text/html' } })).text()
    expect(html).toContain('No such post')
    expect(html).toContain('Raised by')
  })
})

describe('options', () => {
  it('onError can override responses and hono() can customize the app', async () => {
    const custom = createApp(makeSettings(false), {
      onError: (err, c: Context) => (err instanceof PermissionDenied ? c.text('nope', 403) : undefined),
      hono: (h) => {
        h.get('/custom', (c) => c.text('custom route'))
      },
    })
    const c = createTestClient(custom)
    expect(await (await c.get('/errors/403/')).text()).toBe('nope')
    expect((await c.get('/errors/404/')).status).toBe(404)
    expect(await (await c.get('/custom')).text()).toBe('custom route')
  })

  it('accepts a plain settings object', async () => {
    const plain = createApp({
      SECRET_KEY: 'x',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [path('', (c) => c.text('plain'))],
    })
    expect(await (await createTestClient(plain).get('/')).text()).toBe('plain')
  })

  it('returns 500 when startup fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    class Broken extends AppConfig {
      name = 'broken'
      ready() {
        throw new Error('broken ready')
      }
    }
    const broken = createApp(
      defineSettings(() => ({ SECRET_KEY: 'x', DEBUG: true, INSTALLED_APPS: [Broken], ROOT_URLCONF: [] })),
    )
    const res = await createTestClient(broken).get('/')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('broken ready')
    spy.mockRestore()
  })

  it('rejects disallowed hosts', async () => {
    const strict = createApp(makeSettings(false, { ALLOWED_HOSTS: ['example.com', '.example.org'] }))
    expect((await createTestClient(strict).get('/')).status).toBe(400)
    expect((await createTestClient(strict, { baseUrl: 'https://example.com' }).get('/')).status).toBe(200)
    expect(
      (await createTestClient(strict, { baseUrl: 'https://api.example.org:8443' }).get('/')).status,
    ).toBe(200)
    expect((await createTestClient(strict, { baseUrl: 'https://evil.com' }).get('/')).status).toBe(400)
  })
})

describe('scheduled and queue handlers', () => {
  it('dispatches cron triggers by expression', async () => {
    const seen: string[] = []
    onSchedule('0 * * * *', (event, ctx) => {
      seen.push(`hourly ${event.cron} ${ctx.settings.SITE_NAME} ${getEnv().SITE}`)
    })
    onSchedule('*', () => {
      seen.push('any')
    })
    await app.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, { SITE: 'Cron' })
    await app.scheduled({ cron: '5 4 * * *', scheduledTime: Date.now() }, { SITE: 'Cron' })
    expect(seen).toEqual(['hourly 0 * * * * Cron Cron', 'any', 'any'])
  })

  it('propagates handler errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onSchedule('*', () => {
      throw new Error('cron failed')
    })
    await expect(app.scheduled({ cron: 'x', scheduledTime: 0 }, {})).rejects.toThrow('cron failed')
    spy.mockRestore()
  })

  it('dispatches queue batches by queue name', async () => {
    const bodies: unknown[] = []
    onQueue<{ n: number }>('emails', async (batch) => {
      for (const m of batch.messages) {
        bodies.push(m.body.n)
        m.ack()
      }
    })
    const ack = vi.fn()
    const batch = {
      queue: 'emails',
      messages: [1, 2].map((n) => ({
        id: String(n),
        timestamp: new Date(),
        body: { n },
        ack,
        retry: vi.fn(),
      })),
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }
    await app.queue(batch, {})
    expect(bodies).toEqual([1, 2])
    expect(ack).toHaveBeenCalledTimes(2)
    await expect(app.queue({ ...batch, queue: 'other' }, {})).rejects.toThrow(/No onQueue/)
  })
})

describe('app commands', () => {
  it('registers AppConfig.commands on populate', async () => {
    const { BaseCommand, callCommand, commandRegistry, bufferIO } = await import('../src/index')
    class Hello extends BaseCommand {
      static help = 'Say hello'
      async handle(args: Record<string, unknown>, io: any) {
        io.stdout(`hello ${args.name} from ${getSettings().SITE_NAME}`)
      }
    }
    class CmdConfig extends AppConfig {
      name = 'cmds'
      commands = { hello: Hello }
    }
    const cmdApp = createApp(
      defineSettings(() => ({
        SECRET_KEY: 'x',
        SITE_NAME: 'CLI',
        INSTALLED_APPS: [CmdConfig],
        ROOT_URLCONF: [],
      })),
    )
    await cmdApp.setup({})
    expect(commandRegistry.get('hello')).toBe(Hello)
    const io = bufferIO()
    await callCommand('hello', { name: 'world' }, io)
    expect(io.out).toEqual(['hello world from CLI'])
  })
})
