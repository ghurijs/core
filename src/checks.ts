import { type AppConfig, apps } from './apps'
import { tryGetContext } from './context'
import { ImproperlyConfigured } from './errors'
import type { GhuriSettings } from './settings'
import { getResolver, type UrlPatterns } from './urls'

/** Check levels (same numbers as Django). */
export const CheckLevel = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 } as const
const { DEBUG, INFO, WARNING, ERROR, CRITICAL } = CheckLevel

const LEVEL_NAMES: Record<number, string> = {
  10: 'DEBUG',
  20: 'INFO',
  30: 'WARNING',
  40: 'ERROR',
  50: 'CRITICAL',
}

/** One system-check result (Django's CheckMessage). */
export class CheckMessage {
  constructor(
    readonly level: number,
    readonly msg: string,
    readonly opts: { hint?: string; id?: string; obj?: unknown } = {},
  ) {}

  get hint(): string | undefined {
    return this.opts.hint
  }
  get id(): string | undefined {
    return this.opts.id
  }
  get obj(): unknown {
    return this.opts.obj
  }
  get levelName(): string {
    return LEVEL_NAMES[this.level] ?? String(this.level)
  }
  /** ERROR or worse. */
  isSerious(level = ERROR): boolean {
    return this.level >= level
  }
  toString(): string {
    const obj =
      this.obj === undefined
        ? '?'
        : typeof this.obj === 'function'
          ? (this.obj as any).name
          : String(this.obj)
    return `${obj}: (${this.id ?? this.levelName}) ${this.msg}${this.hint ? `\n\tHINT: ${this.hint}` : ''}`
  }
}

export interface CheckContext {
  settings: GhuriSettings
  appConfigs: AppConfig[]
  /** True for `ghuri check --deploy`. */
  deploy: boolean
}

export type CheckFunction = (
  ctx: CheckContext,
) => CheckMessage[] | undefined | Promise<CheckMessage[] | undefined>

interface RegisteredCheck {
  fn: CheckFunction
  tags: string[]
  deployOnly: boolean
}

class CheckRegistry {
  private registered: RegisteredCheck[] = []

  /** Register a check: `checks.register(fn, { tags: ['models'] })`. Deploy-only checks run with `deploy: true`. */
  register(fn: CheckFunction, opts: { tags?: string[]; deploy?: boolean } = {}): CheckFunction {
    if (!this.registered.some((r) => r.fn === fn)) {
      this.registered.push({ fn, tags: opts.tags ?? [], deployOnly: !!opts.deploy })
    }
    return fn
  }

  unregister(fn: CheckFunction): void {
    this.registered = this.registered.filter((r) => r.fn !== fn)
  }

  get tags(): string[] {
    return [...new Set(this.registered.flatMap((r) => r.tags))]
  }

  all(): RegisteredCheck[] {
    return [...this.registered]
  }

  debug = (msg: string, opts?: CheckMessage['opts']) => new CheckMessage(DEBUG, msg, opts)
  info = (msg: string, opts?: CheckMessage['opts']) => new CheckMessage(INFO, msg, opts)
  warning = (msg: string, opts?: CheckMessage['opts']) => new CheckMessage(WARNING, msg, opts)
  error = (msg: string, opts?: CheckMessage['opts']) => new CheckMessage(ERROR, msg, opts)
  critical = (msg: string, opts?: CheckMessage['opts']) => new CheckMessage(CRITICAL, msg, opts)
}

const KEY = Symbol.for('ghuri.core.checks')
/** The system check registry. */
export const checks: CheckRegistry = ((globalThis as any)[KEY] ??= new CheckRegistry())

export interface RunChecksOptions {
  tags?: string[]
  deploy?: boolean
  settings?: GhuriSettings
  /** Silence messages by id (Django's SILENCED_SYSTEM_CHECKS; also read from settings). */
  silenced?: string[]
}

/** Run registered checks. Uses the current context's settings unless given. */
export async function runChecks(opts: RunChecksOptions = {}): Promise<CheckMessage[]> {
  const settings = opts.settings ?? tryGetContext()?.settings
  if (!settings)
    throw new ImproperlyConfigured('runChecks() needs settings (run inside a Ghuri context or pass them).')
  const silenced = new Set([
    ...(opts.silenced ?? []),
    ...((settings.SILENCED_SYSTEM_CHECKS as string[]) ?? []),
  ])
  const ctx: CheckContext = {
    settings,
    appConfigs: apps.ready ? apps.getAppConfigs() : [],
    deploy: !!opts.deploy,
  }
  const out: CheckMessage[] = []
  for (const r of checks.all()) {
    if (r.deployOnly && !opts.deploy) continue
    if (opts.tags?.length && !r.tags.some((t) => opts.tags!.includes(t))) continue
    let msgs: CheckMessage[] | undefined
    try {
      msgs = await r.fn(ctx)
    } catch (err) {
      msgs = [
        new CheckMessage(ERROR, `Check ${r.fn.name || '(anonymous)'} raised: ${(err as Error).message}`, {
          id: 'core.E000',
        }),
      ]
    }
    for (const m of msgs ?? []) if (!m.id || !silenced.has(m.id)) out.push(m)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Built-in checks
// ---------------------------------------------------------------------------------------------

function checkUrls({ settings }: CheckContext): CheckMessage[] {
  const out: CheckMessage[] = []
  const walk = (patterns: UrlPatterns) => {
    for (const p of patterns) {
      if (!p.regex && p.route.startsWith('/') && p.route !== '/') {
        out.push(
          checks.warning(
            `Your URL pattern '${p.route}' has a route beginning with a '/'. Remove this slash as it is unnecessary.`,
            { id: 'urls.W002' },
          ),
        )
      }
      if (p.name?.includes(':')) {
        out.push(
          checks.warning(`Your URL pattern '${p.route}' has a name including a ':'.`, {
            id: 'urls.W003',
            hint: 'Use namespaces instead.',
          }),
        )
      }
      if (p.children) walk(p.children)
    }
  }
  try {
    walk(settings.ROOT_URLCONF as UrlPatterns)
    getResolver(settings.ROOT_URLCONF as UrlPatterns)
  } catch (err) {
    out.push(checks.error((err as Error).message, { id: 'urls.E004' }))
  }
  return out
}

function checkMiddleware({ settings }: CheckContext): CheckMessage[] {
  const out: CheckMessage[] = []
  for (const m of settings.MIDDLEWARE ?? []) {
    if (typeof m !== 'function' && !(m && typeof (m as any).handle === 'function')) {
      out.push(
        checks.error(`MIDDLEWARE entry ${String(m)} is neither a Middleware nor a Hono middleware.`, {
          id: 'core.E001',
        }),
      )
    }
  }
  return out
}

function checkSecurity({ settings }: CheckContext): CheckMessage[] {
  const out: CheckMessage[] = []
  const names = (settings.MIDDLEWARE ?? []).map((m: any) => m?.name ?? m?.constructor?.name)
  if (settings.DEBUG) {
    out.push(checks.warning('You should not have DEBUG set to true in deployment.', { id: 'security.W018' }))
  }
  const key = String(settings.SECRET_KEY ?? '')
  if (
    key.length < 50 ||
    new Set(key).size < 5 ||
    key.startsWith('django-insecure-') ||
    key.startsWith('ghuri-insecure-')
  ) {
    out.push(
      checks.warning(
        'Your SECRET_KEY has less than 50 characters, less than 5 unique characters, or is prefixed with "ghuri-insecure-".',
        {
          id: 'security.W009',
          hint: 'Generate a long random value and store it as a secret (wrangler secret put SECRET_KEY).',
        },
      ),
    )
  }
  if (!names.includes('SecurityMiddleware')) {
    out.push(
      checks.warning("You do not have 'SecurityMiddleware' in your MIDDLEWARE.", { id: 'security.W001' }),
    )
  }
  if (!names.includes('CsrfMiddleware')) {
    out.push(
      checks.warning("You don't appear to be using Ghuri's CSRF protection middleware.", {
        id: 'security.W003',
      }),
    )
  }
  if (!settings.SECURE_HSTS_SECONDS) {
    out.push(
      checks.warning('You have not set a value for the SECURE_HSTS_SECONDS setting.', {
        id: 'security.W004',
      }),
    )
  }
  if (!settings.CSRF_COOKIE_SECURE) {
    out.push(checks.warning('You have not set CSRF_COOKIE_SECURE to true.', { id: 'security.W016' }))
  }
  if ((settings.ALLOWED_HOSTS ?? ['*']).length === 0) {
    out.push(checks.warning('ALLOWED_HOSTS must not be empty in deployment.', { id: 'security.W020' }))
  }
  return out
}

checks.register(checkUrls, { tags: ['urls'] })
checks.register(checkMiddleware, { tags: ['middleware'] })
checks.register(checkSecurity, { tags: ['security'], deploy: true })
