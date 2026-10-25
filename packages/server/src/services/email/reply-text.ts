/**
 * 回信正文里“对方新写的那部分”：去掉引用的原文、转发/回复分隔行之后的内容、签名，
 * 以及我们自己追加的退订脚注。退订检测、询盘打分都只看这一段，免得把我们自己的原文算进去。
 */

/** 回复分隔行：从这一行起（含）后面都是引用的原文 */
const SEPARATORS: RegExp[] = [
  /^-{2,}\s*(?:original message|forwarded message|原始邮件|转发邮件|原邮件)\s*-{2,}\s*$/i,
  /^_{8,}\s*$/, // 常见客户端在引用前插入的一整行下划线
  /^(?:from|发件人|寄件者)\s*[:：].+/i, // 引用头：发件人: xxx（后面紧跟 Sent/Date/发送时间 等）
  /^(?:begin forwarded message|以下是引用)/i,
  /^在.{0,200}写道\s*[:：]?\s*$/,
  /^on\s.{0,300}\bwrote\s*:?\s*$/i,
  /^le\s.{0,300}\ba écrit\s*:?\s*$/i,
  /^am\s.{0,300}\bschrieb\b.{0,100}:?\s*$/i,
  /^el\s.{0,300}\bescribió\s*:?\s*$/i,
]

/** “On Mon, ... ” 一行太长被折成两行时，第二行才出现 wrote: */
const WROTE_TAIL = /^.{0,300}\b(?:wrote|a écrit|schrieb|escribió)\s*:?\s*$|^.{0,200}写道\s*[:：]?\s*$/i
const HEADER_LINE = /^(?:sent|date|to|subject|cc|发送时间|日期|收件人|主题|抄送)\s*[:：]/i

function isSeparator(lines: string[], index: number): boolean {
  const line = lines[index]!.trim()
  if (!line) return false
  if (/^(?:from|发件人|寄件者)\s*[:：]/i.test(line)) {
    // 只有后面紧跟其它引用头时才算引用头，正文里偶然出现的 “From: …” 不截断
    const next = lines.slice(index + 1, index + 4).map((l) => l.trim())
    return next.some((l) => HEADER_LINE.test(l))
  }
  if (SEPARATORS.some((re) => re.test(line))) return true
  // On … 换行 … wrote:
  if (/^(?:on|le|am|el)\s/i.test(line) && index + 1 < lines.length && WROTE_TAIL.test(lines[index + 1]!.trim())) return true
  return false
}

/**
 * 去掉引用原文与签名，返回对方新写的正文；extraStrip 里的固定文字（如退订脚注）也一并去掉。
 * keepSignature：保留对方自己的签名（询盘打分要看对方签名里的公司信息），只去掉引用部分。
 */
export function freshReplyText(text: string, extraStrip: string[] = [], options: { keepSignature?: boolean } = {}): string {
  let body = String(text ?? '').replace(/\r\n?/g, '\n')
  for (const piece of extraStrip) {
    const clean = piece.trim()
    if (clean) body = body.split(clean).join('')
  }
  const lines = body.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (isSeparator(lines, i)) break
    // 签名分隔（“-- ”）之后是签名，不算正文
    if (!options.keepSignature && /^--\s*$/.test(raw)) break
    if (line.startsWith('>')) continue
    kept.push(raw)
  }
  return kept.join('\n').trim()
}
