import { describe, expect, it } from 'vitest'
import {
  CheckLevel,
  CheckMessage,
  CsrfMiddleware,
  checks,
  path,
  runChecks,
  SecurityMiddleware,
} from '../src/index'

const base = { SECRET_KEY: 'short', INSTALLED_APPS: [], ROOT_URLCONF: [path('/bad/', (c) => c.text('x'))] }

describe('system checks', () => {
  it('runs built-in url checks', async () => {
    const msgs = await runChecks({ settings: base as any })
    expect(msgs.map((m) => m.id)).toEqual(['urls.W002'])
    expect(msgs[0].isSerious()).toBe(false)
    expect(msgs[0].toString()).toContain("has a route beginning with a '/'")
  })

  it('reports url errors as serious', async () => {
    const msgs = await runChecks({
      settings: { ...base, ROOT_URLCONF: [path('<bad:x>/', (c) => c.text('x'))] } as any,
    })
    expect(msgs.some((m) => m.id === 'urls.E004' && m.isSerious())).toBe(true)
  })

  it('runs deploy checks only on demand and honors silencing', async () => {
    const settings = {
      ...base,
      ROOT_URLCONF: [],
      DEBUG: true,
      MIDDLEWARE: [SecurityMiddleware, CsrfMiddleware],
    }
    expect(await runChecks({ settings: settings as any })).toEqual([])
    const ids = (await runChecks({ settings: settings as any, deploy: true })).map((m) => m.id)
    expect(ids).toEqual(['security.W018', 'security.W009', 'security.W004', 'security.W016'])
    const silenced = await runChecks({
      settings: { ...settings, SILENCED_SYSTEM_CHECKS: ['security.W018'] } as any,
      deploy: true,
    })
    expect(silenced.map((m) => m.id)).not.toContain('security.W018')
  })

  it('registers custom checks with tags', async () => {
    const fn = checks.register(
      ({ appConfigs }) => [checks.error(`apps: ${appConfigs.length}`, { id: 'my.E001', hint: 'fix it' })],
      {
        tags: ['custom'],
      },
    )
    const msgs = await runChecks({ settings: { ...base, ROOT_URLCONF: [] } as any, tags: ['custom'] })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toBeInstanceOf(CheckMessage)
    expect(msgs[0].level).toBe(CheckLevel.ERROR)
    expect(msgs[0].toString()).toContain('HINT: fix it')
    expect(checks.tags).toContain('custom')
    checks.unregister(fn)
    expect(await runChecks({ settings: { ...base, ROOT_URLCONF: [] } as any, tags: ['custom'] })).toEqual([])
  })

  it('turns crashing checks into errors', async () => {
    const fn = checks.register(() => {
      throw new Error('oops')
    })
    const msgs = await runChecks({ settings: { ...base, ROOT_URLCONF: [] } as any })
    expect(msgs[0].msg).toContain('oops')
    checks.unregister(fn)
  })

  it('needs settings', async () => {
    await expect(runChecks()).rejects.toThrow(/needs settings/)
  })
})
