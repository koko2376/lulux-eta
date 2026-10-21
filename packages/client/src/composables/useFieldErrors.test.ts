import { describe, expect, it } from 'vitest'
import { useFieldErrors } from './useFieldErrors'

describe('useFieldErrors', () => {
  it('require flags blank fields and clear removes them', () => {
    const fe = useFieldErrors<'name' | 'url'>('f')
    expect(fe.require({ name: '  ', url: 'https://x' }, (k) => `${k} required`)).toBe(false)
    expect(fe.errors.name).toBe('name required')
    expect(fe.errors.url).toBeUndefined()
    fe.clear('name')
    expect(fe.errors.name).toBeUndefined()
    fe.set('url', 'bad')
    fe.clear()
    expect(Object.keys(fe.errors)).toHaveLength(0)
    expect(fe.require({ name: 'ok' }, () => 'x')).toBe(true)
  })
})
