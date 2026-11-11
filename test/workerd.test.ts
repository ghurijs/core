// Proves @ghuri/core runs in real workerd (Cloudflare's runtime) with `nodejs_compat`.
// The fixture is bundled with esbuild twice: from src/ (always) and from the built dist/ (when it is up to date).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const distEntry = `${root}dist/index.js`

function distIsFresh(): boolean {
  if (!existsSync(distEntry)) return false
  const built = statSync(distEntry).mtimeMs
  return readdirSync(`${root}src`).every((f) => statSync(`${root}src/${f}`).mtimeMs <= built)
}

const targets: Array<'src' | 'dist'> = distIsFresh() ? ['src', 'dist'] : ['src']

function useDist(): Plugin {
  return {
    name: 'ghuri-core-dist',
    setup(b) {
      b.onResolve({ filter: /\/src\/index$/ }, () => ({ path: distEntry }))
    },
  }
}

async function bundle(target: 'src' | 'dist'): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'],
    external: ['node:*', 'cloudflare:*'],
    plugins: target === 'dist' ? [useDist()] : [],
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

describe.each(targets)('bundle from %s on workerd (nodejs_compat)', (target) => {
  let mf: Miniflare
  const base = 'https://example.com'

  beforeAll(async () => {
    const script = await bundle(target)
    expect(script).toContain('node:async_hooks')
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: '2025-06-01',
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['CACHE'],
        bindings: { SECRET_KEY: 'workerd-secret', SITE_NAME: 'Edge', DEBUG: 'false' },
      }),
    )
    await mf.ready
  }, 60_000)

  afterAll(async () => {
    await mf?.dispose()
  })

  it('serves requests', async () => {
    const res = await mf.dispatchFetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ghuri on workerd')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('routes, reverses and isolates context across concurrent requests', async () => {
    const ids = [1, 2, 3, 4, 5]
    const bodies = await Promise.all(
      ids.map((id) =>
        mf.dispatchFetch(`${base}/demo/posts/${id}/?delay=${(6 - id) * 10}`).then((r) => r.json() as any),
      ),
    )
    for (const [i, b] of bodies.entries()) {
      expect(b).toEqual({ id: ids[i], stateId: ids[i], url: `/demo/posts/${ids[i]}/`, site: 'Edge' })
    }
    const html = await (await mf.dispatchFetch(`${base}/demo/hello/W%3Cb%3E/`)).text()
    expect(html).toBe('<!DOCTYPE html><html><body><h1>Hello W&lt;b&gt;</h1></body></html>')
  })

  it('applies APPEND_SLASH, ALLOWED_HOSTS, CSRF and error handling', async () => {
    const redirect = await mf.dispatchFetch(`${base}/demo/posts/1`, { redirect: 'manual' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/demo/posts/1/')
    expect((await mf.dispatchFetch('https://evil.com/')).status).toBe(400)
    const post = await mf.dispatchFetch(`${base}/demo/posts/1/`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    expect(post.status).toBe(403)
    expect(((await post.json()) as any).detail).toContain('CSRF')
    const csrf = await mf.dispatchFetch(`${base}/csrf/`)
    const cookie = csrf.headers.get('set-cookie')!.split(';')[0]
    const token = cookie.split('=')[1]
    const ok = await mf.dispatchFetch(`${base}/demo/posts/1/`, {
      method: 'POST',
      headers: { cookie, 'x-csrftoken': token, referer: `${base}/csrf/` },
    })
    expect(ok.status).toBe(201)
    const boom = await mf.dispatchFetch(`${base}/boom/`, { headers: { accept: 'application/json' } })
    expect(boom.status).toBe(500)
    expect(await boom.json()).toEqual({ detail: 'Internal Server Error' })
  })

  it('uses the KV cache and dispatches cron triggers', async () => {
    const worker = await mf.getWorker()
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: new Date() })
    const first = (await (await mf.dispatchFetch(`${base}/cache/`)).json()) as any
    const second = (await (await mf.dispatchFetch(`${base}/cache/`)).json()) as any
    expect(first.cronRuns).toBe(1)
    expect(second.hits).toBe(first.hits + 1)
  })
})
