import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localTimeFor } from '../src/utils/country-time.js'

describe('客户当地时间（服务端与客户端同一份实现）', () => {
  it('server/src/utils/country-time.ts 与 client/src/lib/country-time.ts 逐字一致', () => {
    const server = readFileSync(fileURLToPath(new URL('../src/utils/country-time.ts', import.meta.url)), 'utf8')
    const client = readFileSync(fileURLToPath(new URL('../../client/src/lib/country-time.ts', import.meta.url)), 'utf8')
    expect(server).toBe(client)
  })
  it('换算并判断工作时段', () => {
    expect(localTimeFor('沙特', Date.UTC(2026, 10, 11, 8, 0))).toMatchObject({ text: '11:00', workHours: true, tz: 'Asia/Riyadh' })
    expect(localTimeFor('unknown land')).toBeNull()
  })
})
