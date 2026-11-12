import type { Context } from 'hono'

// Kept on globalThis so the main entry and `@ghuri/core/node` share it even if bundled twice.
const KEY = Symbol.for('ghuri.remoteAddr')
const addrs: WeakMap<Request, string> = ((globalThis as any)[KEY] ??= new WeakMap<Request, string>())

/**
 * Record the peer address of an incoming request (what `getRemoteAddr()` returns for it). `serve()` from
 * `@ghuri/core/node` calls this with the socket address; call it yourself from a custom server (Bun, Deno, …)
 * before passing the request to `app.fetch()`.
 */
export function setRemoteAddr(request: Request, addr: string): void {
  addrs.set(request, addr)
}

/** Is this request served by Cloudflare (Workers, or `wrangler dev`/Miniflare)? */
export function isCloudflareRequest(c: Context): boolean {
  if ((globalThis as any).navigator?.userAgent === 'Cloudflare-Workers') return true
  return (c.req.raw as any)?.cf != null
}

/**
 * The client's network address (Django's `request.META['REMOTE_ADDR']`), from sources a client cannot forge:
 * `CF-Connecting-IP` on Cloudflare (Cloudflare sets it and overwrites any client copy), else the socket
 * address recorded by `serve()` / `setRemoteAddr()`, else `c.env.incoming` when the app is served by
 * `@hono/node-server` directly, else `''`. `X-Forwarded-For` is never read here: behind a reverse proxy this
 * is the proxy's address (REST throttles read the header with `NUM_PROXIES`).
 */
export function getRemoteAddr(c: Context): string {
  if (isCloudflareRequest(c)) {
    const ip = c.req.header('cf-connecting-ip')
    if (ip) return ip
  }
  const recorded = addrs.get(c.req.raw)
  if (recorded) return recorded
  const socket = (c.env as any)?.incoming?.socket?.remoteAddress
  return typeof socket === 'string' ? socket : ''
}
