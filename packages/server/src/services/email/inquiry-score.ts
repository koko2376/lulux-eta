/**
 * 询盘打分（纯函数，不访问网络 / 数据库）：按规则给一封询盘打 0–100 分和 A/B/C/D 等级，并给出逐条理由。
 *
 * 规则只看邮件本身能看到的信号：发件域名（公司邮箱 / 免费邮箱 / 回复地址不一致）、需求是否具体
 * （数量、型号规格、贸易术语 / 目的港、目标价、交期）、签名是否完整、索样党特征、钓鱼与付款诈骗特征。
 * 已有客户、制裁初筛命中由调用方查好后传入。还会识别语种，并列出首回要追问的信息。
 */

export type InquiryGrade = 'A' | 'B' | 'C' | 'D'
export type InquiryFlag =
  | 'existing_customer'
  | 'free_mail'
  | 'reply_to_mismatch'
  | 'sample_hunter'
  | 'vague'
  | 'phishing'
  | 'payment_fraud'
  | 'sanctions_hit'

export interface InquiryReason {
  key: string
  label: string
  points: number
}

export interface InquiryAsks {
  quantity: boolean
  product: boolean
  incoterm: boolean
  port: boolean
  targetPrice: boolean
  leadTime: boolean
  sample: boolean
  catalog: boolean
}

export interface InquiryScore {
  score: number
  grade: InquiryGrade
  reasons: InquiryReason[]
  flags: InquiryFlag[]
  /** ISO 639-1，猜不出时为 en */
  language: string
  /** 对方邮件里已经说清楚的点 */
  asks: InquiryAsks
  /** 首回建议追问的信息（中文，给模型 / 业务员看） */
  followUps: string[]
}

export interface InquiryInput {
  fromAddress: string
  fromName?: string
  replyTo?: string[]
  subject: string
  body: string
  attachmentNames?: string[]
  freeMailDomains: ReadonlySet<string>
  existingCustomer?: boolean
  /** 制裁初筛命中的名单条目名（调用方用发件公司名筛过） */
  sanctionsHit?: string | null
}

const BASE = 50

const QUANTITY =
  /\b\d[\d,.]*\s*(?:k\b|pcs|pieces|pc\b|sets?\b|units?\b|tons?\b|tonnes?\b|mt\b|kgs?\b|meters?\b|metres?\b|m2\b|sqm\b|rolls?\b|cartons?\b|pallets?\b|pairs?\b|dozens?\b|containers?\b|x\s*(?:20|40)\s*(?:gp|hq|hc|ft|'))|\b(?:20|40)\s*(?:gp|hq|hc|ft|')\b|\bmoq\b|\b(?:quantity|qty)\s*[:：]?\s*\d|\d+\s*(?:个|件|套|台|吨|只|箱|柜)|(?:\d+\s*(?:шт|штук))/i
const PRODUCT_SPEC =
  /\b(?:model|item\s*no|part\s*(?:no|number)|sku|spec(?:ification)?s?|size|dimension|material|grade|thickness|diameter|voltage|capacity|dn\s?\d+|pn\s?\d+|\d+\s*(?:mm|cm|inch|in\b|"|v\b|kw|hp|w\b|bar|psi|l\b|ml\b))|型号|规格|材质|尺寸|厚度|电压|功率/i
const INCOTERM = /\b(?:EXW|FOB|FCA|CFR|CNF|C&F|CIF|CIP|CPT|DAP|DPU|DDP)\b/
const PORT = /\b(?:port of (?:destination|discharge)|destination port|to the port of|delivery to|ship(?:ped|ping)? to|POD)\b|目的港|发到/i
const TARGET_PRICE = /\b(?:target price|our budget|budget is|best price for|price per (?:unit|piece|pc)|unit price|usd\s?\d|\$\s?\d|eur\s?\d|€\s?\d)|目标价|预算/i
const LEAD_TIME = /\b(?:lead time|delivery (?:time|date)|ship(?:ment)? (?:date|by|before)|need (?:it|them|the goods) by|before (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|within \d+ (?:days|weeks))|交期|交货期/i
const SIGNATURE_PHONE = /(?:tel|phone|mob(?:ile)?|whatsapp|wechat)\s*[:：.]?\s*\+?\d[\d\s()-]{6,}|\+\d{1,3}[\s-]?\d[\d\s-]{6,}/i
const SIGNATURE_WEB = /\b(?:www\.[a-z0-9-]+\.[a-z.]{2,}|https?:\/\/[a-z0-9.-]+\.[a-z]{2,})/i
const SIGNATURE_COMPANY = /\b(?:ltd|limited|llc|inc|corp(?:oration)?|gmbh|s\.?a\.?s?|s\.?r\.?l|s\.?p\.?a|b\.?v|pty|plc|co\.,?\s*ltd|trading|import(?:s|ers?)?|industries|group|company)\b/i
const SAMPLE = /\bsamples?\b|样品|образ(?:ец|цы)|muestras?|amostras?|échantillons?|muster/i
const FREE_SAMPLE = /\bfree samples?\b|samples? (?:for|at no|free of) (?:free|charge|cost)|免费样品/i
const CATALOG_ONLY = /\b(?:catalog(?:ue)?|price ?list|pricelist|brochure|your (?:latest )?products)\b|产品目录|价格表/i
const PHISHING_TEXT =
  /\b(?:verify your (?:account|email|mailbox)|confirm your (?:password|account)|(?:click|tap) (?:here|the (?:link|button)) to (?:view|download|open|access)|view (?:the )?(?:order|invoice|document|purchase order|po) online|your mailbox (?:is|will be)|password (?:expire|expiring)|shared (?:a )?(?:file|document) with you|docusign|sign in to (?:view|download))\b/i
/** 免费托管 / 短链：钓鱼页最常见的落点（正常客户几乎不用它们发订单） */
const PHISHING_LINK = /https?:\/\/[^\s"'<>]*(?:bit\.ly|tinyurl|ipfs|firebasestorage|\.web\.app|\.firebaseapp\.com|weebly|wixsite|000webhost|ngrok|glitch\.me|pages\.dev|r2\.dev)[^\s"'<>]*/i
/** 常见网盘：客户常用它发图纸，不判钓鱼，只提醒确认对方身份 */
const CLOUD_LINK = /https?:\/\/[^\s"'<>]*(?:dropbox|wetransfer|onedrive|1drv\.ms|sharepoint|docs\.google|drive\.google)[^\s"'<>]*/i
const RISKY_ATTACHMENT = /\.(?:html?|shtml|svg|zip|rar|7z|iso|img|exe|scr|js|jar|bat|cmd|vbs|lnk|xlsm|docm|htm)$/i
const PAYMENT_FRAUD =
  /\b(?:change (?:of|in) (?:our )?bank(?:ing)? (?:details|account)|new bank (?:account|details)|update(?:d)? (?:our )?bank(?:ing)? (?:details|information)|western union|moneygram|urgent(?:ly)? (?:payment|wire|transfer)|bitcoin|usdt|crypto ?wallet|gift ?cards?)\b|更改收款账户|新的银行账户/i

const STOPWORDS: Array<[string, RegExp]> = [
  ['es', /\b(?:hola|estimado|estimados|buenos días|precio|cotización|necesitamos|cantidad|gracias|saludos)\b/gi],
  ['pt', /\b(?:olá|prezado|prezados|bom dia|preço|cotação|precisamos|quantidade|obrigado|atenciosamente)\b/gi],
  ['fr', /\b(?:bonjour|madame|monsieur|prix|devis|nous avons besoin|quantité|merci|cordialement)\b/gi],
  ['de', /\b(?:hallo|sehr geehrte|preis|angebot|wir benötigen|menge|danke|mit freundlichen grüßen)\b/gi],
  ['it', /\b(?:buongiorno|gentile|prezzo|preventivo|abbiamo bisogno|quantità|grazie|cordiali saluti)\b/gi],
  ['tr', /\b(?:merhaba|sayın|fiyat|teklif|ihtiyacımız|miktar|teşekkürler|saygılarımızla)\b/gi],
  ['id', /\b(?:halo|bapak|ibu|harga|penawaran|kami membutuhkan|jumlah|terima kasih|salam)\b/gi],
  ['vi', /\b(?:xin chào|kính gửi|giá|báo giá|chúng tôi cần|số lượng|cảm ơn|trân trọng)\b/gi],
  ['en', /\b(?:hello|dear|price|quotation|quote|we need|quantity|thanks|regards|please)\b/gi],
]

/** 粗略识别语种：先看文字系统，再看常见商务用词 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000)
  const count = (re: RegExp) => (sample.match(re) ?? []).length
  const letters = Math.max(1, count(/\p{L}/gu))
  const scripts: Array<[string, number]> = [
    ['ja', count(/[\u3040-\u30ff]/g)],
    ['ko', count(/[\uac00-\ud7af]/g)],
    ['zh', count(/[\u4e00-\u9fff]/g)],
    ['ru', count(/[\u0400-\u04ff]/g)],
    ['ar', count(/[\u0600-\u06ff]/g)],
    ['th', count(/[\u0e00-\u0e7f]/g)],
    ['he', count(/[\u0590-\u05ff]/g)],
  ]
  // 日文混着汉字：假名占比够高才算日文（中文里夹几个假名品牌名不算）
  const kana = scripts[0]![1]
  const han = scripts[2]![1]
  if (kana > 5 && kana / letters > 0.15 && kana >= han * 0.25) return 'ja'
  for (const [lang, n] of scripts.slice(1)) if (n / letters > 0.2) return lang
  let best = 'en'
  let bestHits = 0
  for (const [lang, re] of STOPWORDS) {
    const hits = count(re)
    if (hits > bestHits) {
      best = lang
      bestHits = hits
    }
  }
  return best
}

function domainOf(address: string): string {
  return address.split('@')[1]?.trim().toLowerCase() ?? ''
}

/** 只取注册域（a.b.example.co.uk → example.co.uk），用于比较发件与回复地址是否同一家 */
function baseDomain(domain: string): string {
  const parts = domain.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const sld = parts[parts.length - 2]!
  const takeThree = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne'].includes(sld) && parts[parts.length - 1]!.length === 2
  return parts.slice(takeThree ? -3 : -2).join('.')
}

function gradeOf(score: number): InquiryGrade {
  if (score >= 75) return 'A'
  if (score >= 60) return 'B'
  if (score >= 40) return 'C'
  return 'D'
}

export function scoreInquiry(input: InquiryInput): InquiryScore {
  const text = `${input.subject}\n${input.body}`.slice(0, 50_000)
  const reasons: InquiryReason[] = []
  const flags: InquiryFlag[] = []
  const add = (key: string, label: string, points: number) => reasons.push({ key, label, points })

  const domain = domainOf(input.fromAddress)
  const freeMail = !domain || input.freeMailDomains.has(domain)

  if (input.existingCustomer) {
    add('existing_customer', '已有客户来信', 20)
    flags.push('existing_customer')
  }
  if (freeMail) {
    add('free_mail', '用免费邮箱（Gmail / Outlook 等），公司身份待核实', -10)
    flags.push('free_mail')
  } else {
    add('company_domain', `用公司域名邮箱（${domain}）`, 10)
  }
  const replyDomains = (input.replyTo ?? []).map(domainOf).filter(Boolean)
  if (domain && replyDomains.some((d) => baseDomain(d) !== baseDomain(domain))) {
    add('reply_to_mismatch', `回复地址和发件域名不一致（${replyDomains.find((d) => baseDomain(d) !== baseDomain(domain))}）`, -15)
    flags.push('reply_to_mismatch')
  }

  const asks: InquiryAsks = {
    quantity: QUANTITY.test(text),
    product: PRODUCT_SPEC.test(text),
    incoterm: INCOTERM.test(text),
    port: PORT.test(text),
    targetPrice: TARGET_PRICE.test(text),
    leadTime: LEAD_TIME.test(text),
    sample: SAMPLE.test(text),
    catalog: CATALOG_ONLY.test(text),
  }
  if (asks.quantity) add('quantity', '写明了采购数量', 12)
  if (asks.product) add('product', '写了型号 / 规格 / 材质', 8)
  if (asks.incoterm || asks.port) add('terms', '提到贸易术语或目的港', 6)
  if (asks.targetPrice) add('target_price', '给了目标价或预算', 6)
  if (asks.leadTime) add('lead_time', '提到交期', 4)

  const signals = [SIGNATURE_PHONE.test(input.body), SIGNATURE_WEB.test(input.body), SIGNATURE_COMPANY.test(`${input.body}\n${input.fromName ?? ''}`)].filter(Boolean).length
  if (signals >= 2) add('signature', '签名里有公司名 / 电话 / 网站', 8)
  else if (signals === 0) add('no_signature', '没有公司签名信息', -5)

  const bodyLength = input.body.replace(/\s+/g, ' ').trim().length
  const specific = asks.quantity || asks.product
  if (!specific && asks.catalog) {
    add('vague', '只要目录 / 价格表，没有具体品名和数量', -8)
    flags.push('vague')
  } else if (bodyLength < 120 && !specific) {
    add('short', '内容很短，没有具体需求', -8)
  }
  if (asks.sample && !asks.quantity && (FREE_SAMPLE.test(text) || freeMail)) {
    add('sample_hunter', '只要样品、不提采购量（常见索样党特征）', -12)
    flags.push('sample_hunter')
  }

  const risky = (input.attachmentNames ?? []).filter((name) => RISKY_ATTACHMENT.test(name.trim()))
  const phishing = PHISHING_TEXT.test(text) || (PHISHING_LINK.test(text) && /\b(?:order|invoice|po|quotation|document|file|rfq|drawing)s?\b/i.test(text)) || risky.length > 0
  if (phishing) {
    add('phishing', risky.length > 0 ? `可疑附件（${risky.slice(0, 2).join('、')}），疑似钓鱼` : '要求点链接查看订单 / 登录，疑似钓鱼', -40)
    flags.push('phishing')
  }
  if (!phishing && CLOUD_LINK.test(text)) {
    add('cloud_link', '含网盘链接，打开前确认对方身份', -5)
  }
  if (PAYMENT_FRAUD.test(text)) {
    add('payment_fraud', '提到改收款账户 / 加急付款 / 非常规支付，疑似付款诈骗', -30)
    flags.push('payment_fraud')
  }
  if (input.sanctionsHit) {
    add('sanctions_hit', `发件公司名与制裁名单「${input.sanctionsHit}」相似，需人工核实`, -30)
    flags.push('sanctions_hit')
  }

  let score = BASE + reasons.reduce((sum, reason) => sum + reason.points, 0)
  // 钓鱼 / 制裁命中：不管其它信号多好，最高 D 级
  if (flags.includes('phishing') || flags.includes('sanctions_hit')) score = Math.min(score, 25)
  else if (flags.includes('payment_fraud')) score = Math.min(score, 35)
  score = Math.max(0, Math.min(100, Math.round(score)))

  const followUps: string[] = []
  if (!asks.product) followUps.push('具体品名、型号或规格（最好有图纸 / 图片）')
  if (!asks.quantity) followUps.push('采购数量（首单和年用量）')
  if (!asks.incoterm && !asks.port) followUps.push('贸易术语和目的港')
  if (!asks.targetPrice) followUps.push('目标价或预算')
  if (!asks.leadTime) followUps.push('期望交期')
  if (freeMail) followUps.push('公司名称和官网')

  return { score, grade: gradeOf(score), reasons, flags, language: detectLanguage(text), asks, followUps }
}
