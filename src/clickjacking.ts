import type { Context } from 'hono'
import { viewHasMarker } from './markers'
import { XFRAME_OPTIONS_EXEMPT_MARKER } from './urls'

/**
 * Mark a view (or a mounted Hono app) as exempt from `XFrameOptionsMiddleware` (Django's
 * `xframe_options_exempt`): its responses get no `X-Frame-Options` header from the middleware, so other
 * sites can frame it. A header the view sets itself is always kept. For class views, set
 * `static xframeOptionsExempt = true`.
 *
 * ```ts
 * path('embed/', xframeOptionsExempt(embedView))
 * ```
 */
export function xframeOptionsExempt<T extends object>(view: T): T {
  ;(view as any)[XFRAME_OPTIONS_EXEMPT_MARKER] = true
  return view
}

/** Is the request's view exempt from `XFrameOptionsMiddleware`? */
export function isXFrameOptionsExempt(c: Context): boolean {
  return viewHasMarker(c, XFRAME_OPTIONS_EXEMPT_MARKER)
}
