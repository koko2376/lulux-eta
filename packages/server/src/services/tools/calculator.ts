import { ToolError } from './tool-error.js'

/**
 * 安全的算式求值（递归下降，不使用 eval / Function）。
 * 支持 + - * / % ^（右结合）、括号、一元正负、科学计数法、×÷ 与全角括号，
 * 函数 sqrt cbrt abs round floor ceil trunc min max pow log(=log10) log2 ln exp sin cos tan asin acos atan，常量 pi e。
 */
type Token = { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string }

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  ln: Math.log,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  round: (x: number, digits = 0) => {
    const factor = 10 ** Math.trunc(digits)
    return Math.round(x * factor) / factor
  },
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

function tokenize(input: string): Token[] {
  const source = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',')
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (/\s/.test(ch) || ch === '_') {
      i += 1
      continue
    }
    const num = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i))
    if (num) {
      tokens.push({ type: 'num', value: Number(num[0]) })
      i += num[0].length
      continue
    }
    const id = /^[a-z][a-z0-9]*/i.exec(source.slice(i))
    if (id) {
      tokens.push({ type: 'id', value: id[0].toLowerCase() })
      i += id[0].length
      continue
    }
    if ('+-*/%^(),'.includes(ch)) {
      if (ch === '*' && source[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' })
        i += 2
        continue
      }
      tokens.push({ type: 'op', value: ch })
      i += 1
      continue
    }
    throw new ToolError(`无法识别的字符：${ch}`)
  }
  return tokens
}

export function evaluate(expression: string): number {
  if (expression.length > 1000) throw new ToolError('算式过长')
  const tokens = tokenize(expression)
  let pos = 0
  let depth = 0
  const peek = (): Token | undefined => tokens[pos]
  const isOp = (value: string): boolean => {
    const token = peek()
    return token?.type === 'op' && token.value === value
  }
  const expect = (value: string): void => {
    if (!isOp(value)) throw new ToolError(`缺少 ${value}`)
    pos += 1
  }

  const expr = (): number => {
    let left = term()
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { value: string }).value
      const right = term()
      left = op === '+' ? left + right : left - right
    }
    return left
  }
  const term = (): number => {
    let left = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { value: string }).value
      const right = unary()
      if ((op === '/' || op === '%') && right === 0) throw new ToolError('除数不能为 0')
      left = op === '*' ? left * right : op === '/' ? left / right : left % right
    }
    return left
  }
  const unary = (): number => {
    if (isOp('-')) {
      pos += 1
      return -unary()
    }
    if (isOp('+')) {
      pos += 1
      return unary()
    }
    return power()
  }
  const power = (): number => {
    const base = primary()
    if (isOp('^')) {
      pos += 1
      return base ** unary()
    }
    return base
  }
  const primary = (): number => {
    const token = peek()
    if (!token) throw new ToolError('算式不完整')
    if (token.type === 'num') {
      pos += 1
      return token.value
    }
    if (token.type === 'id') {
      pos += 1
      if (isOp('(')) {
        const fn = FUNCTIONS[token.value]
        if (!fn) throw new ToolError(`未知函数：${token.value}`)
        pos += 1
        const args: number[] = []
        if (!isOp(')')) {
          args.push(nested())
          while (isOp(',')) {
            pos += 1
            args.push(nested())
          }
        }
        expect(')')
        return fn(...args)
      }
      const constant = CONSTANTS[token.value]
      if (constant === undefined) throw new ToolError(`未知名称：${token.value}`)
      return constant
    }
    if (token.value === '(') {
      pos += 1
      const value = nested()
      expect(')')
      return value
    }
    throw new ToolError(`意外的符号：${token.value}`)
  }
  const nested = (): number => {
    depth += 1
    if (depth > 100) throw new ToolError('括号嵌套过深')
    const value = expr()
    depth -= 1
    return value
  }

  const result = expr()
  if (pos < tokens.length) throw new ToolError(`多余的内容：${JSON.stringify(tokens[pos])}`)
  if (!Number.isFinite(result)) throw new ToolError('结果不是有限数')
  return result
}

/** 去掉浮点误差（最多 12 位有效数字） */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)
  return String(Number.parseFloat(value.toPrecision(12)))
}
