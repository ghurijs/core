import type { Context } from 'hono'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppConfig,
  apps,
  BadRequest,
  createApp,
  defineSettings,
  type GhuriSettings,
  getContext,
  getEnv,
  getSettings,
  getUser,
  Http404,
  ImproperlyConfigured,
  loadUser,
  notFoundResponse,
  ObjectDoesNotExist,
  onQueue,
  onSchedule,
  PermissionDenied,
  path,
  Resolver404,
  registerUserLoader,
  requestFinished,
  requestStarted,
  reverse,
  setUser,
  taskHandlers,
  tryGetContext,
  ValidationError,
  wantsJson,
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

describe('HANDLER_404 / HANDLER_500', () => {
  const TENANT_KEY = Symbol('tenant')
  const seen: Array<{ path: string; exception: unknown }> = []
  const tenantMiddleware = async (c: Context, next: () => Promise<void>) => {
    c.set('tenant' as never, 'acme' as never)
    getContext().state.set(TENANT_KEY, 'acme-state')
    await next()
    c.res.headers.set('x-after-middleware', '1')
  }
  const handler404 = (c: Context, exception: Error) => {
    seen.push({ path: c.req.path, exception })
    return c.html(
      `<h1>${c.get('tenant' as never)} store: page not found</h1><p>${getContext().state.get(TENANT_KEY)}|${
        getSettings().SITE_NAME
      }|${c.get('ghuri') === getContext()}|${exception.message}</p>`,
      404,
    )
  }
  const handler500 = (c: Context, exception: unknown) =>
    c.html(`<h1>${c.get('tenant' as never)} store: oops</h1><p>${(exception as Error).message}</p>`, 500)
  const custom = createTestClient(
    createApp(
      makeSettings(false, {
        MIDDLEWARE: [tenantMiddleware],
        HANDLER_404: handler404,
        HANDLER_500: handler500,
      }),
    ),
  )
  const html = { headers: { accept: 'text/html' } }

  afterEach(() => {
    seen.length = 0
    vi.restoreAllMocks()
  })

  it('renders for unmatched paths with status 404', async () => {
    const res = await custom.get('/nothing/here/', html)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('acme store: page not found')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.path).toBe('/nothing/here/')
    expect(seen[0]!.exception).toBeInstanceOf(Resolver404)
    expect(seen[0]!.exception).toBeInstanceOf(Http404)
  })

  it('renders for Http404 and ObjectDoesNotExist raised in views', async () => {
    const res = await custom.get('/errors/404/', html)
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('acme store: page not found')
    expect(body).toContain('No such post')
    expect(seen[0]!.exception).toBeInstanceOf(Http404)
    expect(seen[0]!.exception).not.toBeInstanceOf(Resolver404)
    const dne = await custom.get('/errors/dne/', html)
    expect(dne.status).toBe(404)
    expect(seen[1]!.exception).toBeInstanceOf(ObjectDoesNotExist)
  })

  it('is also used for JSON clients (like Django), and can fall back to notFoundResponse()', async () => {
    expect(await (await custom.get('/api/nothing/')).text()).toContain('page not found')
    const negotiating = createTestClient(
      createApp(
        makeSettings(false, {
          HANDLER_404: (c: Context) => (wantsJson(c) ? notFoundResponse(c) : c.html('themed', 404)),
        }),
      ),
    )
    const res = await negotiating.get('/api/nothing/')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ detail: 'Not found.' })
    expect(await (await negotiating.get('/nothing/', html)).text()).toBe('themed')
  })

  it('runs after the APPEND_SLASH redirect', async () => {
    const res = await custom.get('/posts', { query: { a: 1 } })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/?a=1')
    expect(seen).toHaveLength(0)
    // POST cannot be redirected, so it is a plain 404 through the handler.
    expect((await custom.post('/posts', html)).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('leaves 405 responses alone', async () => {
    const res = await custom.post('/only-get/', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(await res.json()).toEqual({ detail: expect.stringContaining('POST') })
    expect(seen).toHaveLength(0)
  })

  it('sees the request context and values set by middleware', async () => {
    const res = await custom.get('/missing/', html)
    const body = await res.text()
    expect(body).toContain('acme store')
    expect(body).toContain('acme-state|Ghuri|true|')
    // The handler runs inside the middleware chain: middleware code after next() still sees its response.
    expect(res.headers.get('x-after-middleware')).toBe('1')
  })

  it('falls back to the default 404 when the handler throws or returns no Response', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = createTestClient(
      createApp(
        makeSettings(false, {
          HANDLER_404: () => {
            throw new Error('template missing')
          },
        }),
      ),
    )
    for (const url of ['/nothing/', '/errors/404/']) {
      const res = await throwing.get(url, html)
      expect(res.status, url).toBe(404)
      const body = await res.text()
      expect(body, url).toContain('404 Not Found')
      expect(body, url).not.toContain('template missing')
    }
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('HANDLER_404 raised'), expect.any(Error))

    const asyncThrowing = createTestClient(
      createApp(makeSettings(false, { HANDLER_404: async () => Promise.reject(new Error('nope')) })),
    )
    expect((await asyncThrowing.get('/nothing/', html)).status).toBe(404)

    const empty = createTestClient(createApp(makeSettings(false, { HANDLER_404: (() => undefined) as any })))
    const res = await empty.get('/nothing/', html)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('404 Not Found')
  })

  it('is not used with DEBUG on (the technical 404 page shows, like Django)', async () => {
    const debug = createTestClient(createApp(makeSettings(true, { HANDLER_404: handler404 })))
    const res = await debug.get('/nope/', html)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Ghuri tried these URL patterns')
    expect(await (await debug.get('/errors/404/', html)).text()).toContain('Raised by')
    expect(seen).toHaveLength(0)
  })

  it('HANDLER_500 renders uncaught errors only, and falls back when it throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await custom.get('/errors/boom/', html)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('acme store: oops')
    // Errors mapped to a status keep their default responses.
    expect(await (await custom.get('/errors/403/', html)).text()).toContain('403 Forbidden')
    expect((await custom.get('/errors/400/', html)).status).toBe(400)

    const throwing = createTestClient(
      createApp(
        makeSettings(false, {
          HANDLER_500: () => {
            throw new Error('handler broke')
          },
        }),
      ),
    )
    const fallback = await throwing.get('/errors/boom/', html)
    expect(fallback.status).toBe(500)
    expect(await fallback.text()).toContain('500 Server Error')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('HANDLER_500 raised'), expect.any(Error))

    const debug = createTestClient(createApp(makeSettings(true, { HANDLER_500: handler500 })))
    expect(await (await debug.get('/errors/boom/', html)).text()).toContain('Traceback')
  })

  it('keeps the default pages when unset', async () => {
    const missing = await client.get('/nothing/', html)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('404 Not Found')
    const raised = await client.get('/errors/404/', html)
    expect(raised.status).toBe(404)
    expect(await raised.text()).toContain('404 Not Found')
    expect(seen).toHaveLength(0)
  })

  it('types the handlers in GhuriSettings', () => {
    const typed: Pick<GhuriSettings, 'HANDLER_404' | 'HANDLER_500'> = {
      HANDLER_404: (c, exception) => c.html(`<p>${exception.message}</p>`, 404),
      HANDLER_500: async (c) => c.text('Server error', 500),
    }
    expect(typeof typed.HANDLER_404).toBe('function')
  })

  it('rejects handlers that are not functions', () => {
    expect(() => makeSettings(false, { HANDLER_404: 'views.page_not_found' })({})).toThrow(
      ImproperlyConfigured,
    )
    expect(() => makeSettings(false, { HANDLER_500: {} })({})).toThrow(/HANDLER_500 must be a view/)
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
