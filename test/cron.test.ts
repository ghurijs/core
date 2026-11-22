import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppConfig,
  createApp,
  ImproperlyConfigured,
  isValidCron,
  onSchedule,
  parseCron,
  taskHandlers,
} from '../src'
import { startScheduler } from '../src/node'

const at = (iso: string) => new Date(`${iso}Z`)

describe('parseCron (Cloudflare semantics)', () => {
  it('matches plain fields, lists, ranges and steps in UTC', () => {
    const c = parseCron('*/15 9-17 * * *')
    expect(c.matches(at('2026-11-23T09:00:00'))).toBe(true)
    expect(c.matches(at('2026-11-23T09:45:30'))).toBe(true)
    expect(c.matches(at('2026-11-23T09:10:00'))).toBe(false)
    expect(c.matches(at('2026-11-23T18:00:00'))).toBe(false)
    expect(parseCron('0 3 1,15 * *').matches(at('2026-12-15T03:00:00'))).toBe(true)
  })

  it('numbers days of the week 1-7 with 1 = Sunday, and accepts names', () => {
    // 2026-11-22 is a Sunday, 2026-11-23 a Monday
    expect(parseCron('0 17 * * 1').matches(at('2026-11-22T17:00:00'))).toBe(true)
    expect(parseCron('0 17 * * sun').matches(at('2026-11-22T17:00:00'))).toBe(true)
    expect(parseCron('10 7 * * 2-6').matches(at('2026-11-23T07:10:00'))).toBe(true)
    expect(parseCron('10 7 * * mon-fri').matches(at('2026-11-22T07:10:00'))).toBe(false)
    expect(parseCron('0 0 1 JAN *').matches(at('2027-01-01T00:00:00'))).toBe(true)
  })

  it('supports L, LW, W and # like Cloudflare', () => {
    expect(parseCron('0 0 L * *').matches(at('2026-02-28T00:00:00'))).toBe(true)
    expect(parseCron('0 0 L * *').matches(at('2026-02-27T00:00:00'))).toBe(false)
    // last weekday of January 2026 is Friday the 30th (31st is a Saturday)
    expect(parseCron('59 23 LW * *').matches(at('2026-01-30T23:59:00'))).toBe(true)
    expect(parseCron('59 23 LW * *').matches(at('2026-01-31T23:59:00'))).toBe(false)
    // 2026-11-15 is a Sunday → 15W fires on Monday the 16th
    expect(parseCron('0 0 15W * *').matches(at('2026-11-16T00:00:00'))).toBe(true)
    // last Friday of November 2026 is the 27th; third Friday is the 20th
    expect(parseCron('0 18 * * 6L').matches(at('2026-11-27T18:00:00'))).toBe(true)
    expect(parseCron('0 18 * * friL').matches(at('2026-11-20T18:00:00'))).toBe(false)
    expect(parseCron('0 18 * * 6#3').matches(at('2026-11-20T18:00:00'))).toBe(true)
  })

  it('ORs the day fields when both are restricted', () => {
    const c = parseCron('0 0 1 * 2') // the 1st, or any Monday
    expect(c.matches(at('2026-12-01T00:00:00'))).toBe(true)
    expect(c.matches(at('2026-11-23T00:00:00'))).toBe(true)
    expect(c.matches(at('2026-11-24T00:00:00'))).toBe(false)
  })

  it('computes the next firing time', () => {
    expect(parseCron('0 3 * * *').next(at('2026-11-23T03:00:00'))?.toISOString()).toBe(
      '2026-11-24T03:00:00.000Z',
    )
    expect(parseCron('*/5 * * * *').next(at('2026-11-23T10:02:30'))?.toISOString()).toBe(
      '2026-11-23T10:05:00.000Z',
    )
    expect(parseCron('0 0 29 2 *').next(at('2026-03-01T00:00:00'))?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    )
  })

  it('rejects invalid expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(ImproperlyConfigured)
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/)
    expect(() => parseCron('* * * * 0')).toThrow(/out of range 1-7/)
    expect(() => parseCron('5-1 * * * *')).toThrow(/backwards/)
    expect(isValidCron('0 3 * * *')).toBe(true)
    expect(isValidCron('nope')).toBe(false)
  })
})

describe('startScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
    taskHandlers.clear()
  })

  it('fires onSchedule handlers registered in ready() at matching minutes', async () => {
    vi.useFakeTimers({ now: at('2026-11-23T10:00:30') })
    const fired: Array<{ cron: string; at: string }> = []
    class Cron extends AppConfig {
      name = 'crontest'
      ready() {
        onSchedule('*/2 * * * *', (event) => {
          fired.push({ cron: event.cron, at: new Date(event.scheduledTime).toISOString() })
        })
      }
    }
    const app = createApp({ SECRET_KEY: 'x', DEBUG: true, INSTALLED_APPS: [Cron], ROOT_URLCONF: [] } as any, {
      checks: false,
    })
    const scheduler = await startScheduler(app, { env: {}, onStart() {} })
    expect(scheduler.crons).toEqual(['*/2 * * * *'])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await scheduler.stop()
    expect(fired.map((f) => f.at)).toEqual(['2026-11-23T10:02:00.000Z', '2026-11-23T10:04:00.000Z'])
  })

  it('reports handler errors and keeps running', async () => {
    vi.useFakeTimers({ now: at('2026-11-23T10:00:30') })
    const errors: string[] = []
    let calls = 0
    const app = {
      async scheduled() {
        calls++
        throw new Error('boom')
      },
    }
    const scheduler = await startScheduler(app, {
      crons: ['* * * * *'],
      env: {},
      onStart() {},
      onError: (err, cron) => errors.push(`${cron}: ${(err as Error).message}`),
    })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await scheduler.stop()
    expect(calls).toBe(2)
    expect(errors).toEqual(['* * * * *: boom', '* * * * *: boom'])
  })
})
