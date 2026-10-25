import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * User-visible text belongs in the locale files. Chinese string literals are only
 * allowed where they are matched against server data or user input, never shown.
 */
const ALLOWED_FILES = new Set([
  'lib/import.ts', // spreadsheet header aliases matched against imported files
  'lib/prospect-import.ts', // lead spreadsheet header aliases matched against imported files
  'lib/products.ts', // product CSV header aliases matched against imported files
  'lib/kernel.ts', // server reasons in Chinese, mapped to i18n keys
  'lib/session-name.ts', // server default session title, mapped to an i18n key
  'lib/attachments.ts', // parses the attachment note appended by older clients
  'views/SettingsAppearanceView.vue', // the language's own name
  'i18n/locale-names.ts', // each language's own name (login page language picker)
])

const CJK = /[\u3400-\u9fff]/
const ROOT = join(__dirname, '..')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'locales') files(path, out)
    } else if (/\.(ts|vue)$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && name !== 'test-setup.ts') out.push(path)
  }
  return out
}

function literals(code: string, file: string, lineOffset: number): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      CJK.test(node.text)
    ) {
      found.push(
        `${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 + lineOffset}: ${node.text.slice(0, 60)}`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('no hard-coded Chinese in client code', () => {
  it('script literals and template text use i18n', () => {
    const bad: string[] = []
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/')
      if (ALLOWED_FILES.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (file.endsWith('.ts')) {
        bad.push(...literals(source, file, 0).map((hit) => `${rel}:${hit}`))
        continue
      }
      for (const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
        const offset = source.slice(0, match.index).split('\n').length - 1
        bad.push(...literals(match[1]!, file, offset).map((hit) => `${rel}:${hit}`))
      }
      const template = /<template>([\s\S]*)<\/template>/.exec(source)
      if (template) {
        const text = template[1]!.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
        const base = source.slice(0, template.index).split('\n').length
        text.split('\n').forEach((line, index) => {
          if (CJK.test(line)) bad.push(`${rel}:${base + index}: ${line.trim().slice(0, 60)}`)
        })
      }
    }
    expect(bad).toEqual([])
  })
})
