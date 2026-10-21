import { describe, expect, it } from 'vitest'
import type { MessageUsage } from '../api'
import { formatCost, formatCostMap, formatMessageUsage, formatTokens, pricingToRows, rowsToPricing } from './usage'

const usage = (over: Partial<MessageUsage> = {}): MessageUsage => ({
  inputTokens: 1520,
  outputTokens: 230,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  estimated: false,
  calls: 1,
  cost: null,
  currency: null,
  ...over,
})

describe('用量格式化（契约 §6.8-2）', () => {
  it('输入（缓存）/ 输出 · 约费用，估算时加“估”', () => {
    expect(formatMessageUsage(usage())).toBe('输入 1,520 / 输出 230')
    expect(formatMessageUsage(usage({ cacheReadTokens: 1024, cost: 0.0027, currency: 'CNY' }))).toBe(
      '输入 1,520（缓存 1,024）/ 输出 230 · 约 ¥0.0027',
    )
    expect(formatMessageUsage(usage({ estimated: true }))).toBe('输入 1,520 / 输出 230 · 估')
    expect(formatMessageUsage(usage({ reasoningTokens: 90 }))).toContain('（推理 90）')
    expect(formatMessageUsage(null)).toBe('')
  })
  it('Token 与费用', () => {
    expect(formatTokens(123456)).toBe('12.3 万')
    expect(formatTokens(999)).toBe('999')
    expect(formatCost(0.5, 'USD')).toBe('$0.500')
    expect(formatCost(12.345, 'EUR')).toBe('€12.35')
    expect(formatCost(1, 'SEK')).toBe('SEK 1.00')
    expect(formatCostMap({ CNY: 1.2, USD: 0.4 })).toBe('¥1.20 + $0.400')
    expect(formatCostMap({})).toBe('—')
  })
})

describe('modelPricing 表格 ⇄ JSON', () => {
  it('往返转换并规范化币种', () => {
    const rows = pricingToRows('{"deepseek-chat":{"input":2,"output":8,"cacheRead":0.5,"currency":"CNY"}}')
    expect(rows).toEqual([
      { key: 'deepseek-chat', input: '2', output: '8', cacheRead: '0.5', cacheWrite: '', currency: 'CNY' },
    ])
    rows.push({ key: 'OpenAI/gpt-*', input: '1.25', output: '10', cacheRead: '', cacheWrite: '', currency: 'usd' })
    const res = rowsToPricing(rows)
    expect('json' in res && JSON.parse(res.json)).toEqual({
      'deepseek-chat': { input: 2, output: 8, cacheRead: 0.5, currency: 'CNY' },
      'OpenAI/gpt-*': { input: 1.25, output: 10, currency: 'USD' },
    })
  })
  it('校验：缺模型名、重复、非数字、缺输出价；空表 = 清空', () => {
    const base = { input: '1', output: '2', cacheRead: '', cacheWrite: '', currency: 'CNY' }
    expect(rowsToPricing([{ ...base, key: '', input: '3' }])).toEqual({ error: '第 1 行缺少模型名' })
    expect(
      rowsToPricing([
        { ...base, key: 'a' },
        { ...base, key: 'a' },
      ]),
    ).toEqual({ error: '模型「a」重复' })
    expect(rowsToPricing([{ ...base, key: 'a', input: 'abc' }])).toEqual({ error: '「a」的单价不是有效数字：abc' })
    expect(rowsToPricing([{ ...base, key: 'a', output: '' }])).toEqual({ error: '「a」需要填写输出单价' })
    expect(rowsToPricing([])).toEqual({ json: '' })
    expect(() => pricingToRows('[1]')).toThrow()
  })
})
