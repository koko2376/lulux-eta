/**
 * 记忆内容的安全检查（写入前，所有入口共用：工具、设置页、自动提取、导入）。
 *
 * 记忆会进入之后每个会话的系统提示，所以：
 * 1. 绝不保存凭据：API Key / Token、密码、银行卡号、CVV、私钥、带口令的连接串；
 * 2. 拒绝提示注入 / 外泄类内容（“忽略之前的指令”、要求把数据发到某个地址等），避免一条被污染的记忆长期生效；
 * 3. 先做 NFKC，再去掉所有隐藏字符（\p{Cf}、Unicode Tag、变体选择符等，换成空格），它们常被用来藏指令。
 *
 * 思路参考 Hermes Agent 的记忆写入扫描（MIT，NousResearch/hermes-agent），规则与代码为 LULUX 独立实现。
 */

export type GuardReason = 'secret' | 'injection'

export interface GuardResult {
  ok: boolean
  reason?: GuardReason
  /** 给模型 / 用户看的说明（不回显命中的原文） */
  message?: string
}

/**
 * 隐藏字符：所有格式控制符 \p{Cf}（零宽、双向控制、BOM、软连字符、U+2060 系列……）、
 * Unicode Tag 字符 U+E0000–E007F（ASCII smuggling：界面不显示，模型能读到）、变体选择符 U+FE00–FE0F / U+E0100–E01EF、
 * 蒙古文元音分隔符 U+180E。检查时把它们换成空格（免得 `previous\u200Binstructions` 粘成一个词绕过规则），
 * 同时再检查一遍直接删掉后的形态（`ign\u200Bore` → ignore）；保存的是删掉后的文本。
 */
const HIDDEN = /[\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u180E]/gu
/** 各种连字符 / 破折号 / 减号统一成 ASCII “-”（`sk‑proj‑…` 用 U+2011 绕过密钥规则） */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u2E3A\u2E3B]/g

/** 检查用的规范形：NFKC（全角 ＜system＞、罗马数字 Ⅰgnore 还原）→ 去隐藏字符（换成空格）→ 统一连字符 */
export function canonicalForCheck(raw: string): string {
  return raw.normalize('NFKC').replace(HIDDEN, ' ').replace(DASHES, '-')
}

/** 另一种拼法：隐藏字符直接删掉（`ign\u200Bore` 删掉后才是 ignore）。两种形态都要过检查 */
function joinedForCheck(raw: string): string {
  return raw.normalize('NFKC').replace(HIDDEN, '').replace(DASHES, '-')
}

/** 保存用：删掉隐藏字符（不做 NFKC，免得把中文全角标点改成半角）；检查覆盖“换成空格”和“直接删掉”两种形态 */
export function normalizeMemoryText(raw: string): string {
  return raw.normalize('NFC').replace(HIDDEN, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 已存条目进系统提示前再清洗一次（与写入时同一套规则，换行折叠成空格） */
export function sanitizeStoredMemory(raw: string): string {
  return normalizeMemoryText(raw).replace(/\s+/g, ' ').trim()
}

const SECRET_PATTERNS: RegExp[] = [
  // 常见服务商密钥前缀
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // 带口令的连接串 scheme://user:pass@host
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
  // “密码/口令/password/token/api key …：xxx”（显式分隔符，原规则）
  /(?:密码|口令|密钥|秘钥|验证码|pass(?:word|wd|code|phrase)?|pwd|secret|token|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key)\s*(?:是|为|=|:|：)\s*\S{4,}/i,
  // 中文关键词后直接跟 ASCII 口令（“邮箱登录密码 Koko2004!”“密码都是abcd1234”）
  /(?:密码|口令|密钥|秘钥|验证码)\s*(?:都是|改成|改为|设为|设成)?\s*[A-Za-z0-9!@#$%^&*_+=.~-]{4,}/,
  // 英文关键词后跟像口令的词（含数字或符号）：“password is hunter2hunter2”“Use password hunter2 for the ERP”
  /\b(?:pass(?:word|wd|code|phrase)?|pwd|secret|token|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key)\b(?:\s+(?:is|was|are)\s+|\s*=\s*|\s+)(?=[^\s]*[0-9!@#$%^&*_+=~-])[^\s]{4,}/i,
  // 密码 / 卡号后跟中文数字串
  /(?:密码|口令|pass(?:word)?|pwd|卡号)\s*(?:是|为|:|：)?\s*[零〇一二三四五六七八九两]{4,}/i,
  // CVV / 安全码
  /\b(?:cvv2?|cvc2?|安全码)\s*(?:是|为|=|:|：)?\s*\d{3,4}\b/i,
]

/** 13–19 位数字（可带空格/横线）且通过 Luhn 校验 → 视为银行卡号 */
function hasCardNumber(text: string): boolean {
  const candidates = text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []
  for (const raw of candidates) {
    const digits = raw.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) continue
    let sum = 0
    let double = false
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let d = digits.charCodeAt(i) - 48
      if (double) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
      double = !double
    }
    if (sum % 10 === 0) return true
  }
  return false
}

/** 32 位以上无空格的高熵串（十六进制 / base64 形态），多半是密钥 */
function hasHighEntropyToken(text: string): boolean {
  const tokens = text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []
  return tokens.some((token) => {
    if (/^\d+$/.test(token)) return false
    const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(token)).length
    if (/^[a-f0-9]{32,}$/i.test(token)) return true
    return kinds >= 3
  })
}

/** 中文数字写的卡号：13 位以上中文数字转成阿拉伯数字后再做 Luhn */
const CN_DIGITS: Record<string, string> = { 零: '0', 〇: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' }
function hasChineseCardNumber(text: string): boolean {
  const runs = text.match(/[零〇一二两三四五六七八九][零〇一二两三四五六七八九\s-]{11,}[零〇一二两三四五六七八九]/g) ?? []
  return runs.some((run) => hasCardNumber(run.replace(/[零〇一二两三四五六七八九]/g, (c) => CN_DIGITS[c] ?? c)))
}

export function containsSecret(raw: string): boolean {
  return [canonicalForCheck(raw), joinedForCheck(raw)].some(
    (text) => SECRET_PATTERNS.some((re) => re.test(text)) || hasCardNumber(text) || hasChineseCardNumber(text) || hasHighEntropyToken(text),
  )
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?)/i,
  /(?:reveal|print|show|leak|dump)\s+(?:the\s+|your\s+)?system\s+prompt/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak)/i,
  /忽略(?:掉)?(?:之前|以上|前面|上面|先前|所有|全部|系统)(?:的)?(?:所有|全部)?(?:指令|指示|提示|规则|要求|设定)/,
  /(?:输出|泄露|打印|显示|告诉我)(?:你的)?系统提示/,
  /(?:不要|别)(?:告诉|让)用户/,
  /(?:把|将)(?:所有|全部)?(?:客户|数据|资料|对话|记忆|密钥).{0,20}(?:发送|发到|上传|转发)(?:到|给)?\s*(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/,
  /(?:send|post|upload|forward|exfiltrate)\s+(?:all\s+)?(?:the\s+)?(?:data|customers?|conversations?|memory|keys?).{0,40}(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/i,
  /<\s*\/?\s*(?:system|assistant|instructions?)\s*>/i,
]

export function looksLikeInjection(raw: string): boolean {
  return [canonicalForCheck(raw), joinedForCheck(raw)].some((form) => {
    const text = form.replace(/\s+/g, ' ')
    return INJECTION_PATTERNS.some((re) => re.test(text))
  })
}

export function checkMemoryContent(text: string): GuardResult {
  if (containsSecret(text)) {
    return {
      ok: false,
      reason: 'secret',
      message: '内容疑似包含密码、密钥、Token 或银行卡号，记忆里不能保存凭据。',
    }
  }
  if (looksLikeInjection(text)) {
    return {
      ok: false,
      reason: 'injection',
      message: '内容像是改变助手行为的指令（提示注入），不能存入记忆。',
    }
  }
  return { ok: true }
}
