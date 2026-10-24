/**
 * 客户查重用的规范化键（纯函数，迁移与服务共用）。
 */

/** 常见公司后缀 / 组织形式，比较公司名时忽略 */
const COMPANY_SUFFIXES = [
  'co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'pte', 'pty',
  'gmbh', 'ag', 'kg', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'oy', 'ab', 'as', 'aps', 'kk', 'sdn', 'bhd', 'jsc', 'ooo',
  'group', 'holding', 'holdings', 'intl', 'international', 'the',
]
const SUFFIX_SET = new Set(COMPANY_SUFFIXES)
const CJK_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '集团公司', '集团', '公司', '株式会社', '有限会社', '商行']

/**
 * 公司名规范化：全角转半角、小写、去标点，去掉常见组织形式（Co., Ltd. / Inc. / GmbH / 有限公司 …）。
 * 例：「ACME Trading Co., Ltd.」与「acme trading」得到同一个键。只剩后缀时退回去标点后的全名。
 */
export function companyNorm(company: string): string {
  let value = company.normalize('NFKC').toLowerCase().trim()
  if (!value) return ''
  for (const suffix of CJK_SUFFIXES) value = value.split(suffix).join(' ')
  const words = value
    .replace(/[\u2018\u2019'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
  const core = words.filter((word) => !SUFFIX_SET.has(word))
  const joined = (core.length ? core : words).join('')
  return joined
}

/** 免费 / 公共邮箱域名：不能代表一家公司，按域名查重时跳过（同一个完整邮箱仍算重复） */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.com.cn', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'mail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'yandex.com', 'yandex.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru',
  'protonmail.com', 'proton.me', 'pm.me', 'zoho.com', 'tutanota.com', 'fastmail.com', 'hushmail.com', 'rediffmail.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com',
  '189.cn', 'wo.cn', 'tom.com', '21cn.com', 'naver.com', 'daum.net', 'hanmail.net', 'libero.it', 'orange.fr', 'free.fr',
  'laposte.net', 'wanadoo.fr', 't-online.de', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'bol.com.br', 'uol.com.br',
  'terra.com.br', 'rambler.ru', 'btinternet.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
])

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : ''
}

/** 公司邮箱域名（免费邮箱返回空） */
export function companyEmailDomain(email: string): string {
  const domain = emailDomain(email)
  return domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : ''
}

/** 电话查重键：只取数字，至少 7 位；取末 8 位，忽略国家码 / 区号写法差异 */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D+/g, '')
  if (digits.length < 7) return ''
  return digits.length > 8 ? digits.slice(-8) : digits
}
