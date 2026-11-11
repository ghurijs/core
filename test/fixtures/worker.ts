// Tiny Ghuri project used by workerd.test.ts — bundled with esbuild and run in workerd via Miniflare.
import type { Context } from 'hono'
import { html } from 'hono/html'
import {
  AppConfig,
  CommonMiddleware,
  CsrfMiddleware,
  cache,
  createApp,
  defineSettings,
  getContext,
  getCsrfToken,
  include,
  json,
  kvCache,
  kwargs,
  onSchedule,
  path,
  reverse,
  SecurityMiddleware,
  TemplateView,
  View,
} from '../../src/index'

let cronRuns = 0

class DemoConfig extends AppConfig {
  name = 'demo'
  ready() {
    onSchedule('*/5 * * * *', async () => {
      cronRuns++
      await cache.set('cron-runs', cronRuns, null)
    })
  }
}

class PostView extends View {
  async get(c: Context) {
    const ctx = getContext()
    ctx.state.set('id', kwargs(c).id)
    await new Promise((r) => setTimeout(r, Number(c.req.query('delay') ?? 0)))
    return json(c, {
      id: kwargs(c).id,
      stateId: ctx.state.get('id'),
      url: reverse('demo:post', { id: kwargs(c).id }),
      site: ctx.settings.SITE_NAME,
    })
  }
  async post(c: Context) {
    return json(c, { created: true }, 201)
  }
}

class Hello extends TemplateView {
  template = (p: { name: string }) => html`<html><body><h1>Hello ${p.name}</h1></body></html>`
}

const demoUrls = Object.assign(
  [path('posts/<int:id>/', PostView, { name: 'post' }), path('hello/<str:name>/', Hello, { name: 'hello' })],
  { appName: 'demo' },
)

const urlpatterns = [
  path('', (c) => c.text('ghuri on workerd'), { name: 'home' }),
  path('demo/', include(demoUrls)),
  path('csrf/', (c) => json(c, { token: getCsrfToken(c).length })),
  path('cache/', async (c) => {
    const hits = ((await cache.get<number>('hits')) ?? 0) + 1
    await cache.set('hits', hits, 120)
    return json(c, { hits, cronRuns: await cache.get('cron-runs') })
  }),
  path('boom/', () => {
    throw new Error('boom')
  }),
]

const settings = defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  SITE_NAME: env.SITE_NAME ?? 'Ghuri',
  ALLOWED_HOSTS: ['example.com'],
  INSTALLED_APPS: [DemoConfig],
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, CsrfMiddleware],
  ROOT_URLCONF: urlpatterns,
  CACHES: { default: kvCache('CACHE') },
}))

export default createApp(settings)
