import type { Context } from 'hono'
import { matchedRoutes } from 'hono/route'
import { settingsFor } from './exceptions'
import { getResolver } from './urls'

/** Does the request's view (or mounted Hono app) carry `marker`? Internal: used by the `*Exempt()` helpers. */
export function viewHasMarker(c: Context, marker: symbol): boolean {
  try {
    for (const r of matchedRoutes(c)) if ((r.handler as any)?.[marker]) return true
  } catch {
    // no route information
  }
  const settings = settingsFor(c)
  if (!settings) return false
  try {
    const m = getResolver(settings.ROOT_URLCONF as any).match(c.req.path, c.req.method)
    if (!m) return false
    return !!((m.view as any)?.[marker] || (m.app as any)?.[marker])
  } catch {
    return false
  }
}
