import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { describe, expect, it } from 'vitest'
import { CsrfMiddleware, createApp, defineSettings, getContext, getSettings, path } from '../src/index'
import { createTestClient, getTestClientHook, registerTestClientHook, type TestClient } from '../src/testing'

const urls = [
  path('echo/', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    let body: unknown = null
    if (ct.includes('json')) body = await c.req.json()
    else if (ct.includes('form')) {
      const parsed = await c.req.parseBody({ all: true })
      body = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, v instanceof File ? `file:${v.name}:${v.size}` : v]),
      )
    }
    return c.json({
      method: c.req.method,
      query: c.req.queries(),
      body,
      contentType: ct.split(';')[0],
      custom: c.req.header('x-custom') ?? null,
      default: c.req.header('x-default') ?? null,
      cookie: getCookie(c),
    })
  }),
  path('set/', (c) => {
    setCookie(c, 'session', 'abc 123', { path: '/' })
    setCookie(c, 'theme', 'dark')
    return c.text('set')
  }),
  path('clear/', (c) => {
    deleteCookie(c, 'session')
    return c.text('cleared')
  }),
  path('r1/', (c) => c.redirect('/r2/', 302)),
  path('r2/', (c) => c.redirect('/echo/?from=r2', 307)),
  path('bg/', (c) => {
    getContext().executionCtx?.waitUntil(new Promise((r) => setTimeout(r, 10)).then(() => (done = true)))
    return c.text('scheduled')
  }),
]
let done = false

const app = createApp(
  defineSettings((env) => ({
    SECRET_KEY: 'x',
    INSTALLED_APPS: [],
    ROOT_URLCONF: urls,
    MIDDLEWARE: [CsrfMiddleware],
    NAME: env.NAME,
  })),
)

describe('TestClient', () => {
  it('sends json, form, multipart, query and headers', async () => {
    const client = createTestClient(app, { headers: { 'x-default': 'd' } })
    let res = await client.post('/echo/', {
      json: { a: 1 },
      query: { q: ['x', 'y'], n: 1 },
      headers: { 'x-custom': 'c' },
    })
    expect(await res.json()).toMatchObject({
      method: 'POST',
      query: { q: ['x', 'y'], n: ['1'] },
      body: { a: 1 },
      contentType: 'application/json',
      custom: 'c',
      default: 'd',
    })
    res = await client.put('/echo/', { form: { a: '1', many: ['x', 'y'] } })
    expect(await res.json()).toMatchObject({
      method: 'PUT',
      body: { a: '1', many: ['x', 'y'] },
      contentType: 'application/x-www-form-urlencoded',
    })
    res = await client.patch('/echo/', { form: { f: new File(['hello'], 'h.txt'), x: 'y' } })
    expect(await res.json()).toMatchObject({
      method: 'PATCH',
      body: { f: 'file:h.txt:5', x: 'y' },
      contentType: 'multipart/form-data',
    })
    res = await client.delete('/echo/')
    expect((await res.json()).method).toBe('DELETE')
    expect(res.request.method).toBe('DELETE')
  })

  it('keeps cookies across requests', async () => {
    const client = createTestClient(app)
    await client.get('/set/')
    expect(client.getCookie('session')).toBe('abc 123')
    let body = await (await client.get('/echo/')).json()
    expect(body.cookie).toEqual({ session: 'abc 123', theme: 'dark' })
    await client.get('/clear/')
    expect(client.getCookie('session')).toBeUndefined()
    client.setCookie('manual', '1')
    body = await (await client.get('/echo/')).json()
    expect(body.cookie).toEqual({ theme: 'dark', manual: '1' })
    client.clearCookies()
    expect((await (await client.get('/echo/')).json()).cookie).toEqual({})
  })

  it('adds the CSRF header automatically unless disabled', async () => {
    const client = createTestClient(app)
    expect((await client.post('/echo/')).status).toBe(200)
    expect((await client.post('/echo/', { csrf: false })).status).toBe(403)
    const strict = createTestClient(app, { csrf: false })
    expect((await strict.post('/echo/')).status).toBe(403)
  })

  it('follows redirects', async () => {
    const client = createTestClient(app)
    const res = await client.get('/r1/', { follow: true })
    expect(res.redirectChain).toEqual([
      ['/r2/', 302],
      ['/echo/?from=r2', 307],
    ])
    expect((await res.json()).query).toEqual({ from: ['r2'] })
    expect((await client.get('/r1/')).status).toBe(302)
  })

  it('waits for waitUntil tasks', async () => {
    const client = createTestClient(app)
    done = false
    await client.get('/bg/')
    expect(done).toBe(false)
    await client.waitForBackgroundTasks()
    expect(done).toBe(true)
  })

  it('runs code in the app context', async () => {
    const client = createTestClient(app, { env: { NAME: 'ctx' } })
    expect(await client.withContext(() => getSettings().NAME)).toBe('ctx')
    expect((await client.setup())?.settings.NAME).toBe('ctx')
  })

  it('exposes hooks for other packages', async () => {
    await expect(createTestClient(app).forceLogin({ pk: 1 })).rejects.toThrow(
      /No test client hook 'forceLogin'/,
    )
    const calls: unknown[] = []
    registerTestClientHook('forceLogin', (client: TestClient, user: { pk: number }) => {
      calls.push(user.pk)
      client.setCookie('sessionid', `user-${user.pk}`)
    })
    registerTestClientHook('logout', () => {
      calls.push('logout')
    })
    expect(getTestClientHook('forceLogin')).toBeTypeOf('function')
    const client = createTestClient(app)
    await client.forceLogin({ pk: 7 })
    expect((await (await client.get('/echo/')).json()).cookie).toEqual({ sessionid: 'user-7' })
    await client.logout()
    expect(calls).toEqual([7, 'logout'])
    expect(client.getCookie('sessionid')).toBeUndefined()
  })

  it('works with plain Hono apps', async () => {
    const h = new Hono()
    h.get('/x', (c) => c.text(`hi ${(c.env as any)?.WHO}`))
    const client = createTestClient(h, { env: { WHO: 'hono' } })
    expect(await (await client.get('/x')).text()).toBe('hi hono')
  })
})
