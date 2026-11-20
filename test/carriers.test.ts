import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureContext,
  getContextCarriers,
  registerContextCarrier,
  restoreContext,
  unregisterContextCarrier,
} from '../src/index'

const locale = new AsyncLocalStorage<string>()
const region = new AsyncLocalStorage<string>()

function register(name: string, als: AsyncLocalStorage<string>) {
  registerContextCarrier({
    name,
    capture: () => als.getStore(),
    restore: (value, fn) => als.run(value, fn),
  })
}

afterEach(() => {
  unregisterContextCarrier('locale')
  unregisterContextCarrier('region')
})

describe('context carriers', () => {
  it('captures nothing without carriers or values', () => {
    expect(captureContext()).toEqual({})
    register('locale', locale)
    expect(captureContext()).toEqual({})
    expect(getContextCarriers()).toContain('locale')
  })

  it('captures and restores every carrier', async () => {
    register('locale', locale)
    register('region', region)
    const captured = await locale.run('bn', () => region.run('bd', async () => captureContext()))
    expect(captured).toEqual({ locale: 'bn', region: 'bd' })
    expect(locale.getStore()).toBeUndefined()
    const seen = await restoreContext(captured, async () => [locale.getStore(), region.getStore()])
    expect(seen).toEqual(['bn', 'bd'])
  })

  it('ignores unknown keys and empty input (old messages keep working)', async () => {
    register('locale', locale)
    expect(await restoreContext(undefined, () => 'ok')).toBe('ok')
    expect(await restoreContext({}, () => locale.getStore())).toBeUndefined()
    expect(await restoreContext({ gone: 'x', locale: 'en' }, () => locale.getStore())).toBe('en')
  })

  it('passes errors through', async () => {
    register('locale', locale)
    await expect(
      restoreContext({ locale: 'en' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
