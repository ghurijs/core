import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  getResolver,
  ImproperlyConfigured,
  include,
  kwargs,
  NoReverseMatch,
  path,
  registerConverter,
  rePath,
  Resolver404,
  resolve,
  resolverMatch,
  reverse,
  type UrlPatterns,
  urlpatterns,
  View,
} from '../src/index'

const echo = (label: string) => (c: any) =>
  c.json({ label, kwargs: kwargs(c), param: c.req.param(), name: resolverMatch(c)?.viewName ?? null })

function honoFor(patterns: UrlPatterns) {
  const h = new Hono()
  getResolver(patterns).mount(h)
  return h
}

describe('converters', () => {
  const patterns = [
    path('', echo('home'), { name: 'home' }),
    path('posts/<int:id>/', echo('post'), { name: 'post' }),
    path('tags/<slug:slug>/', echo('tag'), { name: 'tag' }),
    path('u/<uuid:uid>/', echo('uuid'), { name: 'uuid' }),
    path('files/<path:p>', echo('files'), { name: 'files' }),
    path('users/<name>/', echo('user'), { name: 'user' }),
    path('d/<int:y>-<int:m>/', echo('ym'), { name: 'ym' }),
  ]
  const h = honoFor(patterns)

  it('compiles to Hono patterns', () => {
    const r = getResolver(patterns)
    expect(r.routes.map((x) => x.honoPath)).toEqual([
      '/',
      '/posts/:id{[0-9]+}/',
      '/tags/:slug{[-a-zA-Z0-9_]+}/',
      expect.stringMatching(/^\/u\/:uid\{\[0-9a-f\]/),
      '/files/:p{.+}',
      '/users/:name/',
      null, // two params in one segment → regex fallback
    ])
  })

  it('matches and converts', async () => {
    let body = await (await h.request('/posts/42/')).json()
    expect(body.kwargs).toEqual({ id: 42 })
    expect(body.param).toEqual({ id: '42' })
    expect(body.name).toBe('post')
    expect((await h.request('/posts/abc/')).status).toBe(404)
    expect((await h.request('/posts/42')).status).toBe(404)
    body = await (await h.request('/tags/hello-world_1/')).json()
    expect(body.kwargs).toEqual({ slug: 'hello-world_1' })
    expect((await h.request('/tags/bad.slug/')).status).toBe(404)
    body = await (await h.request('/u/123e4567-e89b-12d3-a456-426614174000/')).json()
    expect(body.label).toBe('uuid')
    expect((await h.request('/u/123e4567-e89b-12d3-a456-42661417400/')).status).toBe(404)
    body = await (await h.request('/files/a/b/c.txt')).json()
    expect(body.kwargs).toEqual({ p: 'a/b/c.txt' })
    body = await (await h.request('/users/J%C3%BCrgen/')).json()
    expect(body.kwargs).toEqual({ name: 'Jürgen' })
    body = await (await h.request('/d/2024-07/')).json()
    expect(body.kwargs).toEqual({ y: 2024, m: 7 })
    expect((await h.request('/')).status).toBe(200)
  })

  it('reverses', () => {
    const urlconf = patterns as UrlPatterns
    expect(reverse('home', {}, { urlconf })).toBe('/')
    expect(reverse('post', { id: 7 }, { urlconf })).toBe('/posts/7/')
    expect(reverse('post', [7], { urlconf })).toBe('/posts/7/')
    expect(reverse('files', { p: 'a/b c.txt' }, { urlconf })).toBe('/files/a/b%20c.txt')
    expect(reverse('ym', { y: 2024, m: 1 }, { urlconf })).toBe('/d/2024-1/')
    expect(reverse('post', { id: 1 }, { urlconf, query: { page: 2, tag: ['a', 'b'] } })).toBe('/posts/1/?page=2&tag=a&tag=b')
    expect(() => reverse('post', { id: 'abc' }, { urlconf })).toThrow(NoReverseMatch)
    expect(() => reverse('post', {}, { urlconf })).toThrow(NoReverseMatch)
    expect(() => reverse('post', { id: 1, extra: 2 }, { urlconf })).toThrow(NoReverseMatch)
    expect(() => reverse('nope', {}, { urlconf })).toThrow(/not a valid view function or pattern name/)
  })

  it('custom converters', async () => {
    registerConverter('year', { regex: '[0-9]{4}', toJs: Number, toUrl: (v) => String(v).padStart(4, '0') })
    const pats = [path('archive/<year:y>/', echo('archive'), { name: 'archive' })]
    const r = getResolver(pats)
    expect(r.routes[0].honoPath).toBe('/archive/:y{[0-9][0-9][0-9][0-9]}/')
    const body = await (await honoFor(pats).request('/archive/2024/')).json()
    expect(body.kwargs).toEqual({ y: 2024 })
    expect((await honoFor(pats).request('/archive/24/')).status).toBe(404)
    expect(reverse('archive', { y: 99 }, { urlconf: pats })).toBe('/archive/0099/')
  })

  it('rejects bad routes', () => {
    expect(() => getResolver([path('x/<bogus:y>/', echo('x'))])).toThrow(ImproperlyConfigured)
    expect(() => getResolver([path('x/<int:1y>/', echo('x'))])).toThrow(ImproperlyConfigured)
    expect(() => getResolver([path('x/<a>/<a>/', echo('x'))])).toThrow(/more than once/)
    expect(() => path('x/', 42 as any)).toThrow(ImproperlyConfigured)
  })
})

describe('rePath', () => {
  const patterns = [
    rePath('^archive/(?P<year>[0-9]{4})/$', echo('year'), { name: 'year' }),
    rePath('^code/(?<code>[A-Z]{2,3})/$', echo('code'), { name: 'code' }),
    rePath('^complex/(?<n>\\d+)(?:-(?<suffix>[a-z]+))?/$', echo('complex'), { name: 'complex' }),
  ]
  const h = honoFor(patterns)

  it('converts simple regexes to Hono and keeps complex ones as regex routes', () => {
    const r = getResolver(patterns)
    expect(r.routes[0].honoPath).toBe('/archive/:year{[0-9][0-9][0-9][0-9]}/')
    expect(r.routes[1].honoPath).toBe('/code/:code{[A-Z][A-Z][A-Z]?}/')
    expect(r.routes[2].honoPath).toBeNull()
  })

  it('matches', async () => {
    expect((await (await h.request('/archive/2020/')).json()).kwargs).toEqual({ year: '2020' })
    expect((await h.request('/archive/20/')).status).toBe(404)
    expect((await (await h.request('/code/US/')).json()).kwargs).toEqual({ code: 'US' })
    expect((await h.request('/code/USAX/')).status).toBe(404)
    expect((await (await h.request('/complex/12-ab/')).json()).kwargs).toEqual({ n: '12', suffix: 'ab' })
    expect((await (await h.request('/complex/12/')).json()).kwargs).toEqual({ n: '12' })
  })

  it('reverses simple regexes only', () => {
    expect(reverse('year', { year: 1999 }, { urlconf: patterns })).toBe('/archive/1999/')
    expect(() => reverse('year', { year: 99 }, { urlconf: patterns })).toThrow(NoReverseMatch)
    expect(() => reverse('complex', { n: 1 }, { urlconf: patterns })).toThrow(NoReverseMatch)
  })
})

describe('include and namespaces', () => {
  const blogUrls = urlpatterns('blog', [
    path('', echo('blog-index'), { name: 'index' }),
    path('<slug:slug>/', echo('blog-detail'), { name: 'detail' }),
  ])
  const v1 = [path('items/<int:pk>/', echo('item'), { name: 'item' })]
  const api = [path('v1/', include(v1, { namespace: 'v1' }))]
  const legacy = new Hono()
  legacy.get('/', (c) => c.text('legacy root'))
  legacy.get('/ping', (c) => c.text('pong'))
  const patterns = [
    path('blog/', include(blogUrls)),
    path('other-blog/', include(blogUrls, { namespace: 'other' })),
    path('api/', include(api, { namespace: 'api' })),
    path('mod/', { urlpatterns: [path('x/', echo('mod-x'), { name: 'x' })], appName: 'mod' }),
    path('flat/', [path('y/', echo('flat-y'), { name: 'flat-y' })]),
    path('legacy/', legacy),
    path('page/', echo('page'), { name: 'page', kwargs: { template: 'page' } }),
  ]
  const h = honoFor(patterns)

  it('reverses with (nested) namespaces', () => {
    const urlconf = patterns
    expect(reverse('blog:index', {}, { urlconf })).toBe('/blog/')
    expect(reverse('blog:detail', { slug: 'hi' }, { urlconf })).toBe('/blog/hi/')
    expect(reverse('other:detail', { slug: 'hi' }, { urlconf })).toBe('/other-blog/hi/')
    expect(reverse('api:v1:item', { pk: 3 }, { urlconf })).toBe('/api/v1/items/3/')
    expect(reverse('mod:x', {}, { urlconf })).toBe('/mod/x/')
    expect(reverse('flat-y', {}, { urlconf })).toBe('/flat/y/')
    expect(() => reverse('detail', { slug: 'x' }, { urlconf })).toThrow(NoReverseMatch)
  })

  it('routes included patterns and mounted Hono apps', async () => {
    const body = await (await h.request('/api/v1/items/9/')).json()
    expect(body).toMatchObject({ label: 'item', kwargs: { pk: 9 }, name: 'api:v1:item' })
    expect(await (await h.request('/legacy/ping')).text()).toBe('pong')
    expect(await (await h.request('/legacy/')).text()).toBe('legacy root')
    expect((await (await h.request('/page/')).json()).kwargs).toEqual({ template: 'page' })
  })

  it('resolves', () => {
    const m = resolve('/blog/hello/', { urlconf: patterns })
    expect(m).toMatchObject({ urlName: 'detail', namespace: 'blog', viewName: 'blog:detail', kwargs: { slug: 'hello' } })
    expect(resolve('/legacy/anything', { urlconf: patterns }).app).toBe(legacy)
    expect(() => resolve('/missing/', { urlconf: patterns })).toThrow(Resolver404)
    expect(getResolver(patterns).isValidPath('/blog')).toBe(false)
    expect(getResolver(patterns).isValidPath('/blog/')).toBe(true)
  })

  it('accepts View classes and method restrictions', async () => {
    class Hello extends View {
      async get(c: any) {
        return c.text(`hi ${this.kwargs.who}`)
      }
    }
    const pats = [path('hello/<who>/', Hello), path('only-post/', echo('post'), { methods: ['post'] })]
    const app = honoFor(pats)
    expect(await (await app.request('/hello/bob/')).text()).toBe('hi bob')
    expect((await app.request('/only-post/', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/only-post/')).status).toBe(404) // 405 comes from createApp's notFound handler
  })

  it('throws when used without context or urlconf', () => {
    expect(() => reverse('x')).toThrow(ImproperlyConfigured)
  })
})
