import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  createApp,
  defineSettings,
  include,
  json,
  path,
  RedirectView,
  redirect,
  render,
  resolveUrl,
  TemplateView,
  View,
} from '../src/index'
import { createTestClient } from '../src/testing'

class ItemView extends View {
  prefix = 'item'
  async get(c: Context) {
    return json(c, { prefix: this.prefix, id: this.kwargs.id, method: c.req.method })
  }
  async post(c: Context) {
    return json(c, { created: true }, 201)
  }
}

class Layout extends TemplateView {
  template = (p: { title: string; id: number }) => (
    <html lang="en">
      <body>
        <h1>{p.title}</h1>
        <p>#{p.id}</p>
      </body>
    </html>
  )
  override async getContextData() {
    return { ...(await super.getContextData()), title: '<Hello>' }
  }
}

const AsyncList = async (p: { items: string[] }) => (
  <ul>
    {p.items.map((i) => (
      <li>{i}</li>
    ))}
  </ul>
)

const shortcuts = [
  path('json/', (c) => json(c, { big: 10n, set: new Set([1, 2]), map: new Map([['a', 1]]) })),
  path('to-name/', (c) => redirect(c, 'item', { id: 5 })),
  path('to-url/', (c) => redirect(c, '/somewhere/', undefined, { permanent: true })),
  path('to-obj/', (c) => redirect(c, { getAbsoluteUrl: () => '/obj/1/' })),
  path('render/', (c) => render(c, <AsyncList items={['a', 'b']} />, { status: 201 })),
  path('render-str/', (c) => render(c, '<html><body>x</body></html>')),
]

const settings = defineSettings(() => ({
  SECRET_KEY: 'test',
  DEBUG: true,
  INSTALLED_APPS: [],
  ROOT_URLCONF: [
    path('items/<int:id>/', ItemView.asView({ prefix: 'custom' }), { name: 'item' }),
    path('plain/<int:id>/', ItemView),
    path('page/<int:id>/', Layout.asView(), { name: 'page' }),
    path('go/<int:id>/', RedirectView.asView({ patternName: 'item' })),
    path(
      'go-url/<int:id>/',
      RedirectView.asView({ url: '/items/{id}/', permanent: true, queryString: true }),
    ),
    path('gone/', RedirectView.asView()),
    path('s/', include(shortcuts)),
  ],
}))

const client = createTestClient(createApp(settings))

describe('class-based views', () => {
  it('dispatches by method with initkwargs', async () => {
    const res = await client.get('/items/3/')
    expect(await res.json()).toEqual({ prefix: 'custom', id: 3, method: 'GET' })
    expect((await (await client.get('/plain/3/')).json()).prefix).toBe('item')
    expect((await client.post('/items/3/')).status).toBe(201)
  })

  it('answers HEAD with GET and OPTIONS with Allow', async () => {
    const head = await client.head('/items/3/')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const opts = await client.options('/items/3/')
    expect(opts.status).toBe(200)
    expect(opts.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
  })

  it('returns 405 with Allow for unsupported methods', async () => {
    const res = await client.delete('/items/3/', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    expect(await res.json()).toEqual({ detail: 'Method "DELETE" not allowed.' })
  })

  it('rejects method names as initkwargs', () => {
    expect(() => ItemView.asView({ get: () => new Response() } as any)).toThrow(/not accepted/)
  })

  it('exposes viewClass on the view function', () => {
    const fn = ItemView.asView({ prefix: 'x' })
    expect(fn.viewClass).toBe(ItemView)
    expect(fn.viewInitkwargs).toEqual({ prefix: 'x' })
  })
})

describe('TemplateView / render', () => {
  it('renders JSX with escaping and a doctype', async () => {
    const res = await client.get('/page/9/')
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
    expect(html).toContain('<h1>&lt;Hello&gt;</h1>')
    expect(html).toContain('<p>#9</p>')
  })

  it('renders async components and strings', async () => {
    const res = await client.get('/s/render/')
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(await (await client.get('/s/render-str/')).text()).toBe(
      '<!DOCTYPE html><html><body>x</body></html>',
    )
  })

  it('requires a template', async () => {
    class Empty extends TemplateView {}
    const app = createApp(
      defineSettings(() => ({ SECRET_KEY: 'x', INSTALLED_APPS: [], ROOT_URLCONF: [path('', Empty)] })),
    )
    const res = await createTestClient(app).get('/', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(500)
  })
})

describe('RedirectView and shortcuts', () => {
  it('redirects to a pattern name or URL template', async () => {
    let res = await client.get('/go/4/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/items/4/')
    res = await client.get('/go-url/4/?a=1')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/items/4/?a=1')
    res = await client.post('/go/4/')
    expect(res.status).toBe(302)
    expect((await client.get('/gone/')).status).toBe(410)
  })

  it('json() handles bigint, Set and Map', async () => {
    expect(await (await client.get('/s/json/')).json()).toEqual({ big: 10, set: [1, 2], map: { a: 1 } })
  })

  it('redirect() accepts names, URLs and objects', async () => {
    expect((await client.get('/s/to-name/')).headers.get('location')).toBe('/items/5/')
    const perm = await client.get('/s/to-url/')
    expect(perm.status).toBe(301)
    expect(perm.headers.get('location')).toBe('/somewhere/')
    expect((await client.get('/s/to-obj/')).headers.get('location')).toBe('/obj/1/')
  })

  it('resolveUrl falls back to URLs only when they look like URLs', async () => {
    await client.withContext(() => {
      expect(resolveUrl('item', { id: 1 })).toBe('/items/1/')
      expect(resolveUrl('https://example.com/x')).toBe('https://example.com/x')
      expect(resolveUrl('example.com')).toBe('example.com')
      expect(() => resolveUrl('missing-name')).toThrow(/not found/)
    })
  })
})
