import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createApp, defineSettings, getContext, getEnv, getRemoteAddr, path } from '../src/index'
import { createExecutionContext, serve } from '../src/node'

describe('@ghuri/core/node', () => {
  it('serves the app with env and a waitUntil shim', async () => {
    let background = false
    const app = createApp(
      defineSettings((env) => ({
        SECRET_KEY: 'x',
        INSTALLED_APPS: [],
        ROOT_URLCONF: [
          path('', (c) => {
            getContext().executionCtx!.waitUntil(Promise.resolve().then(() => (background = true)))
            return c.json({ greeting: env.GREETING, fromCtx: getEnv().GREETING })
          }),
        ],
      })),
    )
    let listening: (v: unknown) => void
    const ready = new Promise((r) => (listening = r))
    const server = await serve(app, {
      port: 0,
      hostname: '127.0.0.1',
      env: { GREETING: 'hello' },
      handleSignals: false,
      onListen: (i) => listening(i),
    })
    await ready
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(await res.json()).toEqual({ greeting: 'hello', fromCtx: 'hello' })
    expect((await fetch(`http://127.0.0.1:${port}/missing/`)).status).toBe(404)
    await new Promise((r) => setTimeout(r, 5))
    expect(background).toBe(true)
    await new Promise((r) => server.close(r))
  })

  it('exposes the socket address through getRemoteAddr(c), not client headers', async () => {
    const app = createApp(
      defineSettings(() => ({
        SECRET_KEY: 'x',
        INSTALLED_APPS: [],
        ROOT_URLCONF: [path('', (c) => c.json({ addr: getRemoteAddr(c), env: Object.keys(c.env ?? {}) }))],
      })),
    )
    let listening: (v: unknown) => void
    const ready = new Promise((r) => (listening = r))
    const server = await serve(app, {
      port: 0,
      hostname: '127.0.0.1',
      env: { GREETING: 'hello' },
      handleSignals: false,
      onListen: (i) => listening(i),
    })
    await ready
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '8.8.8.8' },
    })
    const body = await res.json()
    expect(body.addr).toMatch(/^(::ffff:)?127\.0\.0\.1$/)
    expect(body.env).toEqual(['GREETING'])
    await new Promise((r) => server.close(r))
  })

  it('execution context drains pending tasks and logs failures', async () => {
    const ctx = createExecutionContext()
    let n = 0
    ctx.waitUntil(new Promise((r) => setTimeout(r, 5)).then(() => n++))
    const orig = console.error
    console.error = () => {}
    ctx.waitUntil(Promise.reject(new Error('ignored')))
    await ctx.drain()
    console.error = orig
    expect(n).toBe(1)
    expect(ctx.pending.size).toBe(0)
  })
})
