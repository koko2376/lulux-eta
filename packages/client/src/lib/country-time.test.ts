import { describe, expect, it } from 'vitest'
import { localTimeFor, zoneForCountry } from './country-time'

describe('country-time', () => {
  it('认 ISO 码、英文名、中文名，大小写与空格不敏感', () => {
    expect(zoneForCountry('DE')?.tz).toBe('Europe/Berlin')
    expect(zoneForCountry('de')?.tz).toBe('Europe/Berlin')
    expect(zoneForCountry('United States')?.tz).toBe('America/New_York')
    expect(zoneForCountry('沙特阿拉伯')?.tz).toBe('Asia/Riyadh')
    expect(zoneForCountry(' U.A.E ')?.tz).toBe('Asia/Dubai')
  })
  it('认不出就返回 null，不猜', () => {
    expect(zoneForCountry('')).toBeNull()
    expect(zoneForCountry('Atlantis')).toBeNull()
    expect(localTimeFor('ZZ')).toBeNull()
  })
  it('换算当地时间并判断工作时段；多时区国家标约', () => {
    // 2026-11-11 (周三) 02:00 UTC = 柏林 03:00（非工作时段）
    const t1 = localTimeFor('DE', Date.UTC(2026, 10, 11, 2, 0))!
    expect(t1).toMatchObject({ text: '03:00', workHours: false, approx: false })
    // 同一天 09:30 UTC = 柏林 10:30（工作时段）
    expect(localTimeFor('Germany', Date.UTC(2026, 10, 11, 9, 30))).toMatchObject({ text: '10:30', workHours: true })
    // 周六白天不算工作时段
    expect(localTimeFor('DE', Date.UTC(2026, 10, 14, 10, 0))?.workHours).toBe(false)
    expect(localTimeFor('US', Date.UTC(2026, 10, 11, 15, 0))).toMatchObject({ text: '10:00', approx: true })
  })
})
