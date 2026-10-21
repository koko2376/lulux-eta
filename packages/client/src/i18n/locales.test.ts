import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import zh from './locales/zh-CN.json'
import { formatMessage, i18n, localized, setLanguage, t } from './index'

type Tree = Record<string, Record<string, string>>
const flat = (tree: Tree): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [scope, entries] of Object.entries(tree))
    for (const [k, v] of Object.entries(entries)) out.set(`${scope}.${k}`, v)
  return out
}
const zhMap = flat(zh as Tree)
const enMap = flat(en as Tree)
const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(vue|ts)$/.test(name) && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('i18n 文案表', () => {
  it('英文与简体中文的键完全一致（缺键即失败）', () => {
    const missingInEn = [...zhMap.keys()].filter((k) => !enMap.has(k))
    const extraInEn = [...enMap.keys()].filter((k) => !zhMap.has(k))
    expect(missingInEn, 'en.json 缺少这些键').toEqual([])
    expect(extraInEn, 'en.json 多出这些键').toEqual([])
  })

  it('代码里用到的每个键都存在', () => {
    const src = join(__dirname, '..')
    const missing: string[] = []
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:\$t|\bt)\(\s*'([a-zA-Z]\w*\.\w+)'/g)) {
        if (!zhMap.has(m[1])) missing.push(`${file.slice(src.length + 1)}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('没有空文案，占位符两种语言一致，英文里没有汉字', () => {
    const bad: string[] = []
    for (const [k, v] of zhMap) {
      const e = enMap.get(k)
      if (!v.trim()) bad.push(`${k}: zh 为空`)
      if (e === undefined) continue
      if (!e.trim()) bad.push(`${k}: en 为空`)
      if (placeholders(v) !== placeholders(e)) bad.push(`${k}: 占位符不一致 ${v} / ${e}`)
      if (/[\u3400-\u9fff]/.test(e)) bad.push(`${k}: en 含汉字 ${e}`)
    }
    expect(bad).toEqual([])
  })

  it('切换语言即时生效，模块级文案表随之更新', () => {
    const table = localized(() => ({ stage: t('labels.k13d6epn') }))
    setLanguage('zh-CN')
    expect(table.stage).toBe(zhMap.get('labels.k13d6epn'))
    setLanguage('en')
    expect(i18n.global.locale.value).toBe('en')
    expect(table.stage).toBe(enMap.get('labels.k13d6epn'))
    expect(document.documentElement.lang).toBe('en')
    setLanguage('zh-CN')
    expect(localStorage.getItem('lulux.language')).toBe('zh-CN')
  })
})

describe('formatMessage plural', () => {
  it('{0:one|many} picks singular for 1, plural otherwise', () => {
    const f = (n: number) => formatMessage('{0} {0:order|orders}', (k) => (k === '0' ? n : undefined))
    expect(f(1)).toBe('1 order')
    expect(f(3)).toBe('3 orders')
    expect(f(0)).toBe('0 orders')
    expect(formatMessage('a | b {x}', () => undefined)).toBe('a | b {x}')
  })
})
