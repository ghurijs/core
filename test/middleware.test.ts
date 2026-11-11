import type { Context, MiddlewareHandler, Next } from 'hono'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  CommonMiddleware,
  CorsMiddleware,
  CsrfMiddleware,
  createApp,
  csrfExempt,
  defineSettings,
  enforceCsrf,
  ensureCsrfCookie,
  GZipMiddleware,
  getCsrfToken,
  isAllowedHost,
  Middleware,
  maskCsrfSecret,
  path,
  rotateCsrfToken,
  SecurityMiddleware,
  unmaskCsrfToken,
  View,
  XFrameOptionsMiddleware,
} from '../src/index'
import { createTestClient } from '../src/testing'

const order: string[] = []

class First extends Middleware {
  async handle(_c: Context, next: Next) {
    order.push('first:before')
    await next()
    order.push('first:after')
  }
}
class Second extends Middleware {
  async handle(c: Context, next: Next) {
    order.push('second:before')
    if (c.req.path === '/short/') return c.text('short-circuited', 299 as any)
    await next()
    order.push('second:after')
    if (c.req.path === '/replace/') return new Response('replaced', { status: 202 })
  }
}
const plain: MiddlewareHandler = async (c, next) => {
  order.push('plain:before')
  await next()
  c.header('X-Plain', '1')
}

function app(settings: Record<string, unknown>, routes = [path('', (c) => c.text('ok'))]) {
  return createApp(
    defineSettings(() => ({ SECRET_KEY: 'k', INSTALLED_APPS: [], ROOT_URLCONF: routes, ...settings }) as any),
  )
}

describe('Middleware chain', () => {
  const client = createTestClient(
    app({ MIDDLEWARE: [First, Second, plain] }, [
      path('', (c) => {
        order.push('view')
        return c.text('ok')
      }),
      path('short/', (c) => c.text('never')),
      path('replace/', (c) => c.text('original')),
    ]),
  )

  it('runs in order, wrapping the view', async () => {
    order.length = 0
    const res = await client.get('/')
    expect(order).toEqual([
      'first:before',
      'second:before',
      'plain:before',
      'view',
      'second:after',
      'first:after',
    ])
    expect(res.headers.get('x-plain')).toBe('1')
  })

  it('can short-circuit or replace the response', async () => {
    const short = await client.get('/short/')
    expect(short.status).toBe(299)
    expect(await short.text()).toBe('short-circuited')
    const replaced = await client.get('/replace/')
    expect(replaced.status).toBe(202)
    expect(await replaced.text()).toBe('replaced')
  })
})

describe('SecurityMiddleware / XFrameOptionsMiddleware', () => {
  it('adds security headers', async () => {
    const res = await createTestClient(
      app({ MIDDLEWARE: [SecurityMiddleware, XFrameOptionsMiddleware] }),
    ).get('/')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })

  it('sends HSTS only over https', async () => {
    const a = app({
      MIDDLEWARE: [SecurityMiddleware],
      SECURE_HSTS_SECONDS: 3600,
      SECURE_HSTS_INCLUDE_SUBDOMAINS: true,
    })
    expect((await createTestClient(a).get('/')).headers.get('strict-transport-security')).toBeNull()
    const https = await createTestClient(a, { baseUrl: 'https://example.com' }).get('/')
    expect(https.headers.get('strict-transport-security')).toBe('max-age=3600; includeSubDomains')
    const proxied = createApp(
      defineSettings(() => ({
        SECRET_KEY: 'k',
        INSTALLED_APPS: [],
        ROOT_URLCONF: [path('', (c) => c.text('ok'))],
        MIDDLEWARE: [SecurityMiddleware],
        SECURE_HSTS_SECONDS: 60,
        SECURE_PROXY_SSL_HEADER: ['X-Forwarded-Proto', 'https'],
      })),
    )
    const res = await createTestClient(proxied, { headers: { 'x-forwarded-proto': 'https' } }).get('/')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=60')
  })

  it('redirects to https when SECURE_SSL_REDIRECT', async () => {
    const a = app(
      { MIDDLEWARE: [SecurityMiddleware], SECURE_SSL_REDIRECT: true, SECURE_REDIRECT_EXEMPT: ['^health/$'] },
      [path('', (c) => c.text('ok')), path('health/', (c) => c.text('ok'))],
    )
    const res = await createTestClient(a).get('/?q=1')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://testserver/?q=1')
    expect((await createTestClient(a).get('/health/')).status).toBe(200)
  })
})

describe('CommonMiddleware', () => {
  it('validates hosts', () => {
    expect(isAllowedHost('example.com:8000', ['example.com'])).toBe(true)
    expect(isAllowedHost('a.b.example.com', ['.example.com'])).toBe(true)
    expect(isAllowedHost('example.com', ['.example.com'])).toBe(true)
    expect(isAllowedHost('badexample.com', ['.example.com'])).toBe(false)
    expect(isAllowedHost('[::1]:8000', ['[::1]'])).toBe(true)
    expect(isAllowedHost('x.com', ['*'])).toBe(true)
  })

  it('allows localhost when DEBUG and ALLOWED_HOSTS is empty', async () => {
    const a = app({ DEBUG: true, ALLOWED_HOSTS: [], MIDDLEWARE: [CommonMiddleware] })
    expect((await createTestClient(a, { baseUrl: 'http://localhost:8787' }).get('/')).status).toBe(200)
    expect((await createTestClient(a, { baseUrl: 'http://evil.test' }).get('/')).status).toBe(400)
  })

  it('PREPEND_WWW', async () => {
    const a = app({ MIDDLEWARE: [CommonMiddleware], PREPEND_WWW: true })
    const res = await createTestClient(a, { baseUrl: 'https://example.com' }).get('/?x=1')
    expect(res.headers.get('location')).toBe('https://www.example.com/?x=1')
  })

  it('APPEND_SLASH also works for 404 responses passing through it', async () => {
    const a = app({ MIDDLEWARE: [CommonMiddleware] }, [path('docs/', (c) => c.text('docs'))])
    const res = await createTestClient(a).get('/docs')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/docs/')
  })
})

describe('CorsMiddleware', () => {
  it('uses the CORS setting', async () => {
    const a = app({
      MIDDLEWARE: [CorsMiddleware],
      CORS: { allowOrigins: ['https://app.test'], allowCredentials: true },
    })
    const c = createTestClient(a)
    const res = await c.get('/', { headers: { origin: 'https://app.test' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    const other = await c.get('/', { headers: { origin: 'https://evil.test' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    const preflight = await c.options('/', {
      headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('is a no-op when CORS is false and accepts options', async () => {
    const off = await createTestClient(app({ MIDDLEWARE: [CorsMiddleware] })).get('/', {
      headers: { origin: 'https://x.test' },
    })
    expect(off.headers.get('access-control-allow-origin')).toBeNull()
    const star = await createTestClient(app({ MIDDLEWARE: [new CorsMiddleware({ allowOrigins: '*' })] })).get(
      '/',
      {
        headers: { origin: 'https://x.test' },
      },
    )
    expect(star.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('GZipMiddleware', () => {
  it('compresses on Node', async () => {
    const big = 'x'.repeat(5000)
    const a = app({ MIDDLEWARE: [GZipMiddleware] }, [path('', (c) => c.text(big))])
    const res = await createTestClient(a).get('/', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
  })
})

describe('CSRF', () => {
  class FormView extends View {
    async get(c: Context) {
      return c.html(`<form><input name="csrfmiddlewaretoken" value="${getCsrfToken(c)}"></form>`)
    }
    async post(c: Context) {
      return c.text('posted')
    }
  }
  const exemptHono = new Hono()
  exemptHono.post('/hook', (c) => c.text('hooked'))
  const routes = [
    path('form/', FormView, { name: 'form' }),
    path(
      'exempt/',
      csrfExempt((c: Context) => c.text('exempt ok')),
    ),
    path(
      'ensure/',
      ensureCsrfCookie((c) => c.text('cookie set')),
    ),
    path('rotate/', (c) => {
      rotateCsrfToken(c)
      return c.text('rotated')
    }),
    path(
      'manual/',
      csrfExempt(async (c: Context) => {
        await enforceCsrf(c)
        return c.text('manual ok')
      }),
    ),
    path('hooks/', csrfExempt(exemptHono)),
  ]
  const csrfApp = app(
    { MIDDLEWARE: [CsrfMiddleware], CSRF_TRUSTED_ORIGINS: ['https://*.trusted.test'] },
    routes,
  )
  const json = { headers: { accept: 'application/json' } }

  it('masks and unmasks tokens', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF'
    const masked = maskCsrfSecret(secret)
    expect(masked).toHaveLength(64)
    expect(masked).not.toContain(secret)
    expect(unmaskCsrfToken(masked)).toBe(secret)
  })

  it('rejects unsafe requests without cookie or token', async () => {
    const c = createTestClient(csrfApp, { csrf: false })
    let res = await c.post('/form/', json)
    expect(res.status).toBe(403)
    expect((await res.json()).detail).toContain('CSRF cookie not set.')
    await c.get('/form/')
    res = await c.post('/form/', json)
    expect(res.status).toBe(403)
    expect((await res.json()).detail).toContain('CSRF token missing.')
    res = await c.post('/form/', { ...json, headers: { ...json.headers, 'x-csrftoken': 'x'.repeat(32) } })
    expect((await res.json()).detail).toContain('incorrect')
    res = await c.post('/form/', { headers: { 'x-csrftoken': 'short' } })
    expect(await res.text()).toContain('incorrect length')
  })

  it('sets the cookie when the token is used and accepts header, form field and masked tokens', async () => {
    const c = createTestClient(csrfApp, { csrf: false })
    const page = await c.get('/form/')
    const cookie = page.headers.get('set-cookie')!
    expect(cookie).toMatch(/^csrftoken=[a-zA-Z0-9]{32}; Max-Age=31449600; Path=\/; SameSite=Lax/)
    const masked = /value="([a-zA-Z0-9]{64})"/.exec(await page.text())![1]
    const secret = c.getCookie('csrftoken')!
    expect(unmaskCsrfToken(masked)).toBe(secret)

    expect(await (await c.post('/form/', { form: { csrfmiddlewaretoken: masked } })).text()).toBe('posted')
    expect(await (await c.post('/form/', { headers: { 'X-CSRFToken': masked } })).text()).toBe('posted')
    expect(await (await c.post('/form/', { headers: { 'X-CSRFToken': secret } })).text()).toBe('posted')
    expect((await c.put('/form/', { headers: { 'X-CSRFToken': secret }, ...{} })).status).toBe(405)
    // the cookie is not re-sent once it exists
    expect((await c.get('/form/')).headers.get('set-cookie')).toBeNull()
  })

  it('the test client sends the token automatically', async () => {
    const c = createTestClient(csrfApp)
    expect(await (await c.post('/form/')).text()).toBe('posted')
    expect(c.getCookie('csrftoken')).toHaveLength(32)
  })

  it('checks Origin and Referer', async () => {
    const c = createTestClient(csrfApp, { baseUrl: 'https://site.test' })
    let res = await c.post('/form/', { headers: { origin: 'https://evil.test', accept: 'application/json' } })
    expect((await res.json()).detail).toContain('Origin checking failed')
    res = await c.post('/form/', { headers: { origin: 'https://site.test' } })
    expect(res.status).toBe(200)
    res = await c.post('/form/', { headers: { origin: 'https://a.trusted.test' } })
    expect(res.status).toBe(200)
    res = await c.post('/form/', json)
    expect((await res.json()).detail).toContain('Referer checking failed - no Referer.')
    res = await c.post('/form/', { headers: { referer: 'https://site.test/form/' } })
    expect(res.status).toBe(200)
    res = await c.post('/form/', {
      headers: { referer: 'http://site.test/form/', accept: 'application/json' },
    })
    expect((await res.json()).detail).toContain('insecure')
    res = await c.post('/form/', {
      headers: { referer: 'https://x.trusted.test/', accept: 'application/json' },
    })
    expect(res.status).toBe(200)
  })

  it('skips exempt views and mounted apps, supports enforceCsrf()', async () => {
    const c = createTestClient(csrfApp, { csrf: false })
    expect(await (await c.post('/exempt/')).text()).toBe('exempt ok')
    expect(await (await c.post('/hooks/hook')).text()).toBe('hooked')
    expect((await c.post('/manual/')).status).toBe(403)
    expect(await (await createTestClient(csrfApp).post('/manual/')).text()).toBe('manual ok')
  })

  it('ensureCsrfCookie and rotateCsrfToken set the cookie', async () => {
    const c = createTestClient(csrfApp, { csrf: false })
    expect((await c.get('/ensure/')).headers.get('set-cookie')).toMatch(/^csrftoken=/)
    const before = c.getCookie('csrftoken')
    await c.get('/rotate/')
    expect(c.getCookie('csrftoken')).not.toBe(before)
  })

  it('CSRF_COOKIE_* settings are honored', async () => {
    const a = app(
      {
        MIDDLEWARE: [CsrfMiddleware],
        CSRF_COOKIE_NAME: 'xsrf',
        CSRF_COOKIE_SECURE: true,
        CSRF_COOKIE_HTTPONLY: true,
        CSRF_HEADER_NAME: 'X-XSRF',
      },
      routes,
    )
    const c = createTestClient(a, { csrfCookieName: 'xsrf', csrfHeaderName: 'X-XSRF' })
    const res = await c.get('/ensure/')
    expect(res.headers.get('set-cookie')).toMatch(/^xsrf=.*HttpOnly; Secure/)
    expect((await c.post('/form/')).status).toBe(200)
  })
})
