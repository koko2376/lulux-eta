/**
 * SKILL.md 的 YAML frontmatter 解析（开放 Agent Skills 格式）。
 * 不引入 YAML 依赖：只实现 frontmatter 实际会用到的子集——
 * 映射（任意缩进层级）、块列表（`- x`）、流式列表/映射（`[a, b]`、`{a: 1}`）、
 * 单/双引号字符串、块标量（`|`、`>`，含 `-`/`+` 修饰）、注释、布尔/数字/null。
 * 不支持锚点、别名、标签、多文档；遇到无法理解的写法抛 FrontmatterError。
 */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

interface Line {
  indent: number
  text: string
  no: number
}

function stripComment(raw: string): string {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && raw[i + 1] === "'") {
          i += 1
          continue
        }
        quote = null
      } else if (ch === '\\' && quote === '"') {
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i).trimEnd()
  }
  return raw.trimEnd()
}

function unquoteDouble(body: string, no: number): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    i += 1
    switch (next) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case '0': out += '\0'; break
      case 'u': {
        const hex = body.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new FrontmatterError(`第 ${no} 行：\\u 转义不正确`)
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 4
        break
      }
      default:
        throw new FrontmatterError(`第 ${no} 行：不支持的转义 \\${next ?? ''}`)
    }
  }
  return out
}

/** 解析标量或流式集合（单行） */
function parseInline(raw: string, no: number): YamlValue {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return text === '' ? '' : null
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new FrontmatterError(`第 ${no} 行：双引号未闭合`)
    return unquoteDouble(text.slice(1, -1), no)
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new FrontmatterError(`第 ${no} 行：单引号未闭合`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[')) return parseFlow(text, no)
  if (text.startsWith('{')) return parseFlow(text, no)
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new FrontmatterError(`第 ${no} 行：不支持 YAML 锚点/别名/标签`)
  }
  if (/^(true|True|TRUE)$/.test(text)) return true
  if (/^(false|False|FALSE)$/.test(text)) return false
  if (/^[-+]?\d+$/.test(text) && text.length < 16) return Number.parseInt(text, 10)
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number.parseFloat(text)
  return text
}

/** 流式集合：[a, "b, c", {k: v}] / {a: 1, b: [x]} */
function parseFlow(text: string, no: number): YamlValue {
  let pos = 0
  const fail = (msg: string): never => {
    throw new FrontmatterError(`第 ${no} 行：${msg}`)
  }
  const ws = (): void => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1
  }
  const scalar = (stops: string): YamlValue => {
    ws()
    const ch = text[pos]
    if (ch === '[' || ch === '{') return value()
    if (ch === '"' || ch === "'") {
      const start = pos
      pos += 1
      while (pos < text.length) {
        if (text[pos] === '\\' && ch === '"') {
          pos += 2
          continue
        }
        if (text[pos] === ch) {
          if (ch === "'" && text[pos + 1] === "'") {
            pos += 2
            continue
          }
          break
        }
        pos += 1
      }
      if (pos >= text.length) fail('引号未闭合')
      pos += 1
      return parseInline(text.slice(start, pos), no)
    }
    const start = pos
    while (pos < text.length && !stops.includes(text[pos]!)) pos += 1
    return parseInline(text.slice(start, pos), no)
  }
  const value = (): YamlValue => {
    ws()
    if (text[pos] === '[') {
      pos += 1
      const list: YamlValue[] = []
      ws()
      if (text[pos] === ']') {
        pos += 1
        return list
      }
      while (pos < text.length) {
        list.push(scalar(',]'))
        ws()
        if (text[pos] === ',') {
          pos += 1
          ws()
          if (text[pos] === ']') {
            pos += 1
            return list
          }
          continue
        }
        if (text[pos] === ']') {
          pos += 1
          return list
        }
        fail('流式列表格式不正确')
      }
      fail('流式列表未闭合')
    }
    if (text[pos] === '{') {
      pos += 1
      const map: Record<string, YamlValue> = {}
      ws()
      if (text[pos] === '}') {
        pos += 1
        return map
      }
      while (pos < text.length) {
        const key = scalar(':,}')
        ws()
        if (text[pos] !== ':') fail('流式映射缺少冒号')
        pos += 1
        map[String(key)] = scalar(',}')
        ws()
        if (text[pos] === ',') {
          pos += 1
          continue
        }
        if (text[pos] === '}') {
          pos += 1
          return map
        }
        fail('流式映射格式不正确')
      }
      fail('流式映射未闭合')
    }
    return scalar(',]}')
  }
  const result = value()
  ws()
  if (pos !== text.length) fail('流式集合后有多余内容')
  return result
}

/** 找到 key: value 的冒号（引号外、后面是空白或行尾） */
function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if ((ch === '"' || ch === "'") && i === 0) {
      quote = ch
      continue
    }
    if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]!))) {
      let key = text.slice(0, i).trim()
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)
      return { key, rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

class Parser {
  private index = 0
  constructor(
    private readonly lines: Line[],
    private readonly rawLines: string[],
  ) {}

  private peek(): Line | undefined {
    return this.lines[this.index]
  }

  parseDocument(): Record<string, YamlValue> {
    if (this.lines.length === 0) return {}
    const first = this.lines[0]!
    const value = this.parseBlock(first.indent)
    if (this.index < this.lines.length) {
      throw new FrontmatterError(`第 ${this.lines[this.index]!.no} 行：缩进不正确`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrontmatterError('frontmatter 顶层必须是键值映射')
    return value
  }

  private parseBlock(indent: number): YamlValue {
    const line = this.peek()
    if (!line) return null
    if (line.text === '-' || line.text.startsWith('- ')) return this.parseList(indent)
    return this.parseMap(indent)
  }

  private parseList(indent: number): YamlValue[] {
    const list: YamlValue[] = []
    while (true) {
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) throw new FrontmatterError(`第 ${line.no} 行：缩进不正确`)
      if (!(line.text === '-' || line.text.startsWith('- '))) break
      this.index += 1
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      if (rest === '') {
        const next = this.peek()
        list.push(next && next.indent > indent ? this.parseBlock(next.indent) : null)
        continue
      }
      const kv = rest.startsWith('[') || rest.startsWith('{') || rest.startsWith('"') || rest.startsWith("'") ? null : splitKey(rest)
      if (kv) {
        // "- key: value" 开头的映射项：后续同级键的缩进 = indent + 2
        const childIndent = indent + 2 + (line.text.slice(2).length - line.text.slice(2).trimStart().length)
        const map: Record<string, YamlValue> = {}
        this.assignKey(map, kv.key, kv.rest, childIndent, line.no)
        const next = this.peek()
        if (next && next.indent === childIndent && !(next.text === '-' || next.text.startsWith('- '))) {
          Object.assign(map, this.parseMap(childIndent))
        }
        list.push(map)
        continue
      }
      list.push(this.scalarOrBlockScalar(rest, indent, line.no))
    }
    return list
  }

  private parseMap(indent: number): Record<string, YamlValue> {
    const map: Record<string, YamlValue> = {}
    while (true) {
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) throw new FrontmatterError(`第 ${line.no} 行：缩进不正确`)
      if (line.text === '-' || line.text.startsWith('- ')) break
      const kv = splitKey(line.text)
      if (!kv || !kv.key) throw new FrontmatterError(`第 ${line.no} 行：应为“键: 值”`)
      this.index += 1
      if (Object.prototype.hasOwnProperty.call(map, kv.key)) throw new FrontmatterError(`第 ${line.no} 行：重复的键 ${kv.key}`)
      this.assignKey(map, kv.key, kv.rest, indent, line.no)
    }
    return map
  }

  private assignKey(map: Record<string, YamlValue>, key: string, rest: string, indent: number, no: number): void {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new FrontmatterError(`第 ${no} 行：非法键名`)
    if (rest === '') {
      const next = this.peek()
      if (next && (next.indent > indent || (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))))) {
        map[key] = this.parseBlock(next.indent)
      } else {
        map[key] = null
      }
      return
    }
    map[key] = this.scalarOrBlockScalar(rest, indent, no)
  }

  private scalarOrBlockScalar(rest: string, indent: number, no: number): YamlValue {
    const block = /^([|>])([+-]?)(\d?)\s*$/.exec(rest)
    if (!block) return parseInline(rest, no)
    const folded = block[1] === '>'
    const chomp = block[2]
    // 块标量：读取原始行（保留空行与内部缩进）
    const collected: string[] = []
    let blockIndent = -1
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!
      if (line.indent <= indent) break
      this.index += 1
    }
    // 用原始行重建：从 no 的下一行开始到当前 index 指向的行之前
    const endNo = this.index < this.lines.length ? this.lines[this.index]!.no : this.rawLines.length + 1
    for (let n = no + 1; n < endNo; n += 1) {
      const raw = this.rawLines[n - 1] ?? ''
      if (raw.trim() === '') {
        collected.push('')
        continue
      }
      const ind = raw.length - raw.trimStart().length
      if (blockIndent < 0) blockIndent = ind
      collected.push(raw.slice(Math.min(blockIndent, ind)))
    }
    while (collected.length > 0 && collected[collected.length - 1] === '' && chomp !== '+') collected.pop()
    let text: string
    if (folded) {
      text = ''
      for (let i = 0; i < collected.length; i += 1) {
        const cur = collected[i]!
        if (i === 0) text = cur
        else if (cur === '') text += '\n'
        else if (collected[i - 1] === '' || /^\s/.test(cur)) text += cur
        else text += ` ${cur}`
      }
    } else {
      text = collected.join('\n')
    }
    return chomp === '-' ? text : `${text}\n`
  }
}

/** 解析 YAML 子集 */
export function parseYaml(source: string): Record<string, YamlValue> {
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n')
  const lines: Line[] = []
  rawLines.forEach((raw, i) => {
    if (/^\t/.test(raw)) throw new FrontmatterError(`第 ${i + 1} 行：YAML 不能用 Tab 缩进`)
    const text = stripComment(raw)
    if (!text.trim()) return
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), no: i + 1 })
  })
  return new Parser(lines, rawLines).parseDocument()
}

export interface SplitResult {
  frontmatter: string
  body: string
}

/** 把 SKILL.md 拆成 frontmatter 文本与正文；没有 frontmatter 抛错 */
export function splitFrontmatter(markdown: string): SplitResult {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n') && text !== '---') throw new FrontmatterError('SKILL.md 必须以 --- 开头的 YAML frontmatter 开始')
  const end = text.indexOf('\n---', 3)
  if (end < 0) throw new FrontmatterError('frontmatter 缺少结束的 ---')
  const after = text.slice(end + 4)
  if (after && !after.startsWith('\n')) throw new FrontmatterError('frontmatter 结束的 --- 必须独占一行')
  return { frontmatter: text.slice(4, end), body: after.replace(/^\n/, '') }
}

/** 序列化（只用于 Agent 自写的 skill，输出简单、可被上面的解析器读回） */
export function stringifyYaml(value: Record<string, YamlValue>, indent = 0): string {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      lines.push(`${pad}${key}:`)
      lines.push(stringifyYaml(val, indent + 2))
    } else if (Array.isArray(val)) {
      if (val.every((item) => item === null || typeof item !== 'object')) {
        lines.push(`${pad}${key}: [${val.map((item) => scalarText(item, true)).join(', ')}]`)
      } else {
        lines.push(`${pad}${key}:`)
        for (const item of val) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const inner = stringifyYaml(item, indent + 4).split('\n')
            lines.push(`${pad}  - ${inner[0]!.trimStart()}`, ...inner.slice(1))
          } else {
            lines.push(`${pad}  - ${scalarText(item as YamlValue, false)}`)
          }
        }
      }
    } else {
      lines.push(`${pad}${key}: ${scalarText(val, false)}`)
    }
  }
  return lines.join('\n')
}

function scalarText(value: YamlValue, inFlow: boolean): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  const needsQuote =
    text === '' ||
    /^[\s]|[\s]$/.test(text) ||
    /[:#\n"'\\]|^[-?[\]{}&*!|>%@`]/.test(text) ||
    (inFlow && /[,[\]{}]/.test(text)) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(text) ||
    /^[-+]?(\d|\.\d)/.test(text)
  return needsQuote ? JSON.stringify(text) : text
}
