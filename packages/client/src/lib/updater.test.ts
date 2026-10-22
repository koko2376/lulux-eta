import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LICENSE_CHANGE_DATE, LICENSE_NAME, LICENSE_POINTS, parseThirdParty } from './about'
import { formatMB, formatSpeed, getUpdater, limitationText, relativeTime } from './updater'

describe('自动更新工具函数', () => {
  it('优先 window.lulux.updater，旧 preload 回退 luluxAgent.updater，浏览器为 null', () => {
    const u = { getState: () => 0, onState: () => 0 }
    expect(getUpdater({ lulux: { platform: 'win32', updater: u } } as unknown as Window)).toBe(u)
    expect(getUpdater({ luluxAgent: { updater: u } } as unknown as Window)).toBe(u)
    expect(getUpdater({} as Window)).toBeNull()
    expect(getUpdater({ lulux: { platform: 'x', updater: {} } } as unknown as Window)).toBeNull()
  })
  it('限制原因文案', () => {
    expect(limitationText('unconfigured')).toBe('此版本未配置更新源')
    expect(limitationText('dev')).toBe('开发模式不检查更新')
    expect(limitationText('mac-unsigned')).toContain('未签名')
    expect(limitationText(null)).toBe('')
  })
  it('大小、速度、相对时间', () => {
    expect(formatMB(0)).toBe('0 MB')
    expect(formatMB(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatMB(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatSpeed(512 * 1024)).toBe('512 KB/s')
    expect(formatSpeed(2.5 * 1024 * 1024)).toBe('2.5 MB/s')
    expect(formatSpeed(0)).toBe('')
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(relativeTime(null, now)).toBe('从未')
    expect(relativeTime('2026-10-20T11:59:40Z', now)).toBe('刚刚')
    expect(relativeTime('2026-10-20T11:30:00Z', now)).toBe('30 分钟前')
    expect(relativeTime('2026-10-20T07:00:00Z', now)).toBe('5 小时前')
    expect(relativeTime('2026-10-18T12:00:00Z', now)).toBe('2 天前')
    expect(relativeTime('2026-09-01T00:00:00Z', now)).toBe('2026-09-01')
  })
})

describe('关于页许可与第三方清单', () => {
  it('许可为 BSL 1.1，2030-10-20 转 Apache-2.0', () => {
    expect(LICENSE_NAME).toBe('Business Source License 1.1')
    expect(LICENSE_CHANGE_DATE).toBe('2030-10-20')
    expect(LICENSE_POINTS.join('')).toContain('禁止去除作者署名')
    // 与仓库根目录 LICENSE 一致
    const license = readFileSync(resolve(__dirname, '../../../../LICENSE'), 'utf8')
    expect(license.startsWith('Business Source License 1.1')).toBe(true)
    expect(license).toContain('koko')
  })
  it('解析 THIRD_PARTY_LICENSES.md：生产依赖、Electron 运行时、Hermes 技能（MIT）', () => {
    const md = readFileSync(resolve(__dirname, '../../../../THIRD_PARTY_LICENSES.md'), 'utf8')
    const list = parseThirdParty(md)
    const vue = list.find((e) => e.name === 'vue')
    expect(vue?.license).toBe('MIT')
    expect(vue?.group).toBe('生产依赖')
    expect(list.some((e) => e.name.startsWith('Electron') && e.group === '随桌面安装包分发')).toBe(true)
    const hermes = list.filter((e) => e.group.includes('Hermes'))
    expect(hermes.length).toBeGreaterThanOrEqual(10)
    expect(hermes.every((e) => e.license === 'MIT')).toBe(true)
    expect(list.some((e) => e.name === 'docx' && e.group.includes('按需'))).toBe(true)
    // 汇总表与跳过列表不进入清单
    expect(list.some((e) => e.name === 'MIT' || e.name === 'Upstream path')).toBe(false)
  })
})
