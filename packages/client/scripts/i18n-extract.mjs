// 一次性/可重复运行的中文文案抽取：把 src 下 .vue 模板与脚本里的中文字面量替换为 $t()/t()，
// 文案写入 src/i18n/locales/zh-CN.json（已存在的键保留）。
// 用法：node scripts/i18n-extract.mjs [--dry] [--report out.json] [files...]
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as babelParse, parseExpression } from '@babel/parser'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const LOCALE = join(SRC, 'i18n/locales/zh-CN.json')
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const reportIdx = args.indexOf('--report')
const REPORT = reportIdx >= 0 ? args[reportIdx + 1] : null
const explicit = args.filter((a) => !a.startsWith('--') && a !== REPORT)

const HAS_HAN = /[\u3400-\u9fff]/
const SKIP_FILES = [/\.test\.ts$/, /\.d\.ts$/, /\/i18n\//]
const SKIP_ATTRS = new Set([
  'class',
  'style',
  'id',
  'for',
  'name',
  'type',
  'value',
  'key',
  'ref',
  'src',
  'href',
  'lang',
])

const messages = existsSync(LOCALE) ? JSON.parse(readFileSync(LOCALE, 'utf8')) : {}
const report = []

function walkDir(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walkDir(p, out)
    else if (/\.(vue|ts)$/.test(n) && !SKIP_FILES.some((r) => r.test(p))) out.push(p)
  }
  return out
}

function scopeOf(file) {
  let b = basename(file).replace(/\.(vue|ts)$/, '')
  if (b !== 'View' && b.endsWith('View')) b = b.slice(0, -4)
  if (file.includes('/api/')) b = 'api' + b[0].toUpperCase() + b.slice(1)
  if (file.includes('/stores/')) b = 'store' + b[0].toUpperCase() + b.slice(1)
  return b[0].toLowerCase() + b.slice(1).replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
}

function keyFor(scope, msg) {
  const h = createHash('sha1').update(msg).digest('hex')
  let id = 'k' + parseInt(h.slice(0, 8), 16).toString(36)
  messages[scope] ??= {}
  while (messages[scope][id] !== undefined && messages[scope][id] !== msg) id += 'x'
  messages[scope][id] = msg
  return `${scope}.${id}`
}

const q = (s) => `'${s}'`

/* ───── JS 表达式/脚本中的中文字面量 ───── */
function collectLiterals(ast, base, out, fnDepth0 = 0) {
  const visit = (node, parent, key, fnDepth) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return
    if (
      node.type.startsWith('TS') &&
      node.type !== 'TSAsExpression' &&
      node.type !== 'TSNonNullExpression' &&
      node.type !== 'TSSatisfiesExpression'
    )
      return
    if (node.type === 'CallExpression') {
      const c = node.callee
      const name =
        c.type === 'Identifier'
          ? c.name
          : c.type === 'MemberExpression' && c.object.type === 'Identifier'
            ? c.object.name
            : ''
      if (['console', 't', '$t', 'RegExp'].includes(name)) return
      if (c.type === 'Identifier' && (c.name === 't' || c.name === '$t')) return
    }
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'RegExp') return
    const isFn = /Function|Method/.test(node.type)
    const depth = fnDepth + (isFn ? 1 : 0)
    if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      const text = node.type === 'StringLiteral' ? node.value : node.quasis.map((x) => x.value.cooked).join('')
      if (HAS_HAN.test(text)) {
        let skip = ''
        if (!parent) skip = ''
        else if (
          (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty') &&
          key === 'key' &&
          !parent.computed
        )
          skip = 'object-key'
        else if (parent && parent.type === 'BinaryExpression' && /^[!=]==?$/.test(parent.operator)) skip = 'comparison'
        else if (parent && parent.type === 'SwitchCase') skip = 'switch'
        else if (parent && parent.type === 'TaggedTemplateExpression') skip = 'tagged'
        out.push({ node, start: base + node.start, end: base + node.end, text, skip, moduleLevel: depth === 0 })
        if (node.type === 'StringLiteral') return
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra')
        continue
      const v = node[k]
      if (Array.isArray(v)) for (const c of v) visit(c, node, k, depth)
      else if (v && typeof v.type === 'string') visit(v, node, k, depth)
    }
  }
  visit(ast, null, null, fnDepth0)
}

/** 把一段代码里的中文字面量替换为 fn('key', [...])；返回新代码 */
function rewriteCode(code, lits, scope, fn, offset, file) {
  // 只替换最外层（模板字符串表达式内部的字面量先替换进参数）
  lits.sort((a, b) => a.start - b.start)
  const top = []
  for (const l of lits) {
    if (l.skip) {
      report.push({ file, kind: 'skipped-' + l.skip, text: l.text })
      continue
    }
    if (top.length && l.start < top[top.length - 1].end) {
      top[top.length - 1].inner.push(l)
      continue
    }
    top.push({ ...l, inner: [] })
  }
  let outCode = code
  for (const l of top.reverse()) {
    let repl
    const n = l.node
    if (n.type === 'StringLiteral') {
      repl = `${fn}(${q(keyFor(scope, n.value))})`
    } else {
      let msg = ''
      const params = []
      n.quasis.forEach((qq, i) => {
        msg += qq.value.cooked
        if (i < n.expressions.length) {
          const e = n.expressions[i]
          const s = e.start + (l.start - n.start)
          const en = e.end + (l.start - n.start)
          let ecode = code.slice(s - offset, en - offset)
          const inner = l.inner.filter((x) => x.start >= s && x.end <= en)
          if (inner.length)
            ecode = rewriteCode(
              ecode,
              inner.map((x) => ({ ...x })),
              scope,
              fn,
              s,
              file,
            )
          msg += `{${params.length}}`
          params.push(ecode)
        }
      })
      if (!HAS_HAN.test(n.quasis.map((x) => x.value.cooked).join(''))) continue
      repl = `${fn}(${q(keyFor(scope, msg))}${params.length ? `, [${params.join(', ')}]` : ''})`
    }
    report.push({ file, kind: l.moduleLevel ? 'module-level' : 'script', text: l.text })
    outCode = outCode.slice(0, l.start - offset) + repl + outCode.slice(l.end - offset)
  }
  return outCode
}

function rewriteExpr(code, scope, file) {
  let ast
  try {
    ast = parseExpression(code, { plugins: ['typescript'] })
  } catch {
    try {
      // v-on 语句形式
      ast = babelParse(code, { plugins: ['typescript'], sourceType: 'module' }).program
    } catch {
      report.push({ file, kind: 'unparsed-expr', text: code })
      return code
    }
  }
  const lits = []
  collectLiterals(ast, 0, lits, 1)
  if (!lits.length) return code
  return rewriteCode(code, lits, scope, '$t', 0, file)
}

function rewriteScript(content, scope, file, isSetup) {
  let ast
  try {
    ast = babelParse(content, { plugins: ['typescript'], sourceType: 'module' })
  } catch (e) {
    report.push({ file, kind: 'unparsed-script', text: String(e) })
    return content
  }
  const lits = []
  collectLiterals(ast.program, 0, lits, isSetup ? 1 : 0)
  if (!lits.filter((l) => !l.skip).length) {
    for (const l of lits) report.push({ file, kind: 'skipped-' + l.skip, text: l.text })
    return content
  }
  let out = rewriteCode(content, lits, scope, 't', 0, file)
  if (out !== content && !/import \{[^}]*\bt\b[^}]*\} from '[./]*i18n'/.test(out)) {
    const rel = relative(dirname(file), join(SRC, 'i18n')).replace(/\\/g, '/')
    const imp = `import { t } from '${rel.startsWith('.') ? rel : './' + rel}'\n`
    // 放在最后一个 import 之后
    const imports = [...out.matchAll(/^import [\s\S]*?from ['"][^'"]+['"]\n/gm)]
    if (imports.length) {
      const last = imports[imports.length - 1]
      const at = last.index + last[0].length
      out = out.slice(0, at) + imp + out.slice(at)
    } else out = imp + out
  }
  return out
}

/* ───── 模板 ───── */
const ENT = {
  '&nbsp;': '\u00a0',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&times;': '×',
  '&middot;': '·',
}
function rewriteTemplate(tpl, src, scope, file) {
  const edits = []
  const exprEdit = (node) => {
    const code = node.content
    if (!HAS_HAN.test(code)) return
    const next = rewriteExpr(code, scope, file)
    if (next !== code) edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: next })
  }
  const walk = (node) => {
    if (node.type === 1) {
      for (const p of node.props) {
        if (p.type === 6 && p.value && HAS_HAN.test(p.value.content) && !SKIP_ATTRS.has(p.name)) {
          const msg = p.value.content.replace(/&[a-z#0-9]+;/g, (m) => ENT[m] ?? m)
          edits.push({
            start: p.loc.start.offset,
            end: p.loc.end.offset,
            text: `:${p.name}="$t(${q(keyFor(scope, msg))})"`,
          })
          report.push({ file, kind: 'attr', text: msg })
        } else if (p.type === 7 && p.exp && !['for', 'slot', 'model'].includes(p.name)) {
          exprEdit(p.exp)
        }
      }
      // 子节点：连续的文本 + 插值组成一句
      let group = []
      const flush = () => {
        if (group.some((g) => g.type === 2 && HAS_HAN.test(g.content))) {
          const start = group[0].loc.start.offset
          const end = group[group.length - 1].loc.end.offset
          const raw = src.slice(start, end)
          const lead = raw.match(/^\s*/)[0]
          const trail = raw.match(/\s*$/)[0]
          let msg = ''
          const params = []
          for (const g of group) {
            if (g.type === 2) msg += src.slice(g.loc.start.offset, g.loc.end.offset)
            else {
              let code = g.content.content
              if (HAS_HAN.test(code)) code = rewriteExpr(code, scope, file)
              msg += `{${params.length}}`
              params.push(code.trim())
            }
          }
          msg = msg
            .replace(/\s*\n\s*/g, ' ')
            .trim()
            .replace(/&[a-z#0-9]+;/g, (m) => ENT[m] ?? m)
          const call = `$t(${q(keyFor(scope, msg))}${params.length ? `, [${params.join(', ')}]` : ''})`
          edits.push({ start, end, text: `${lead}{{ ${call} }}${trail}` })
          report.push({ file, kind: 'text', text: msg })
        } else {
          for (const g of group) if (g.type === 5) exprEdit(g.content)
        }
        group = []
      }
      for (const c of node.children) {
        if (c.type === 2 || c.type === 5) group.push(c)
        else {
          flush()
          walk(c)
        }
      }
      flush()
    } else if (node.type === 0) {
      let group = []
      for (const c of node.children) walk(c)
      void group
    } else if (node.type === 5) exprEdit(node.content)
  }
  // 根节点
  const rootWrap = { type: 1, props: [], children: tpl.ast.children }
  walk(rootWrap)
  return edits
}

function apply(src, edits) {
  edits.sort((a, b) => b.start - a.start)
  let out = src
  let lastStart = Infinity
  for (const e of edits) {
    if (e.end > lastStart) continue // 重叠（不应出现）
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    lastStart = e.start
  }
  return out
}

const files = explicit.length ? explicit.map((f) => join(ROOT, f)) : walkDir(SRC)
let changed = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  if (!HAS_HAN.test(src)) continue
  const scope = scopeOf(file)
  let out = src
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(src, { filename: file })
    const edits = []
    if (descriptor.template) {
      const tpl = descriptor.template
      // compiler-sfc 的模板 AST 位置是整个 .vue 文件里的偏移
      for (const e of rewriteTemplate(tpl, src, scope, file)) edits.push(e)
    }
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue
      const next = rewriteScript(block.content, scope, file, block === descriptor.scriptSetup)
      if (next !== block.content) edits.push({ start: block.loc.start.offset, end: block.loc.end.offset, text: next })
    }
    out = apply(src, edits)
  } else {
    out = rewriteScript(src, scope, file, false)
  }
  if (out !== src) {
    changed++
    if (!DRY) writeFileSync(file, out)
  }
}
if (!DRY) writeFileSync(LOCALE, JSON.stringify(messages, null, 2) + '\n')
if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 1))
const kinds = {}
for (const r of report) kinds[r.kind] = (kinds[r.kind] || 0) + 1
console.log({ changed, kinds, keys: Object.values(messages).reduce((n, m) => n + Object.keys(m).length, 0) })
