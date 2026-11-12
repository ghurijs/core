import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineSettings, getRemoteAddr, path, setRemoteAddr } from '../src/index'

const app = createApp(
  defineSettings(() => ({
    SECRET_KEY: 'x',
    INSTALLED_APPS: [],
    ROOT_URLCONF: [path('', (c: Context) => c.json({ addr: getRemoteAddr(c) }))],
  })),
)

async function addrOf(request: Request, env: Record<string, unknown> = {}): Promise<string> {
  const res = await app.fetch(request, env)
  return ((await res.json()) as { addr: string }).addr
}

const spoofed = { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', 'cf-connecting-ip': '8.8.8.8' }

describe('getRemoteAddr', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('trusts no client-sent header off Cloudflare', async () => {
    expect(await addrOf(new Request('http://localhost/', { headers: spoofed }))).toBe('')
  })

  it('uses CF-Connecting-IP on Cloudflare Workers', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    expect(await addrOf(new Request('http://localhost/', { headers: spoofed }))).toBe('8.8.8.8')
  })

  it('uses CF-Connecting-IP when the request carries request.cf', async () => {
    const req = new Request('http://localhost/', { headers: spoofed })
    Object.defineProperty(req, 'cf', { value: { colo: 'DAC' } })
    expect(await addrOf(req)).toBe('8.8.8.8')
  })

  it('uses the address recorded with setRemoteAddr()', async () => {
    const req = new Request('http://localhost/', { headers: spoofed })
    setRemoteAddr(req, '203.0.113.5')
    expect(await addrOf(req)).toBe('203.0.113.5')
  })

  it('falls back to c.env.incoming (plain @hono/node-server)', async () => {
    const env = { incoming: { socket: { remoteAddress: '192.0.2.1' } } }
    expect(await addrOf(new Request('http://localhost/', { headers: spoofed }), env)).toBe('192.0.2.1')
  })
})
