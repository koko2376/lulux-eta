/**
 * 客户所在国家的当地时间：客户列表里一眼看出“现在给他发消息 / 打电话合不合适”。
 *
 * 客户的国家字段是自由文本（可能是 ISO 两位码、英文名或中文名），这里只认常见写法；
 * 认不出就不显示，绝不猜。跨多个时区的国家（美国、巴西、俄罗斯、澳大利亚等）取首都 / 最大商业城市时区，
 * 界面上用 approx=true 标出“约”，不冒充精确值。
 */

interface Zone {
  tz: string
  /** 国土跨多个时区：显示时标“约” */
  multi?: boolean
}

const Z = (tz: string, multi = false): Zone => (multi ? { tz, multi } : { tz })

/** ISO 3166-1 alpha-2 → 主时区（外贸常见市场） */
const BY_CODE: Record<string, Zone> = {
  CN: Z('Asia/Shanghai'), HK: Z('Asia/Hong_Kong'), MO: Z('Asia/Macau'), TW: Z('Asia/Taipei'),
  JP: Z('Asia/Tokyo'), KR: Z('Asia/Seoul'), SG: Z('Asia/Singapore'), MY: Z('Asia/Kuala_Lumpur'),
  TH: Z('Asia/Bangkok'), VN: Z('Asia/Ho_Chi_Minh'), PH: Z('Asia/Manila'), ID: Z('Asia/Jakarta', true),
  IN: Z('Asia/Kolkata'), PK: Z('Asia/Karachi'), BD: Z('Asia/Dhaka'), LK: Z('Asia/Colombo'),
  AE: Z('Asia/Dubai'), SA: Z('Asia/Riyadh'), QA: Z('Asia/Qatar'), KW: Z('Asia/Kuwait'), OM: Z('Asia/Muscat'),
  BH: Z('Asia/Bahrain'), IL: Z('Asia/Jerusalem'), TR: Z('Europe/Istanbul'), IR: Z('Asia/Tehran'), IQ: Z('Asia/Baghdad'),
  KZ: Z('Asia/Almaty', true), UZ: Z('Asia/Tashkent'),
  GB: Z('Europe/London'), UK: Z('Europe/London'), IE: Z('Europe/Dublin'), DE: Z('Europe/Berlin'), FR: Z('Europe/Paris'),
  IT: Z('Europe/Rome'), ES: Z('Europe/Madrid'), PT: Z('Europe/Lisbon'), NL: Z('Europe/Amsterdam'), BE: Z('Europe/Brussels'),
  LU: Z('Europe/Luxembourg'), CH: Z('Europe/Zurich'), AT: Z('Europe/Vienna'), DK: Z('Europe/Copenhagen'),
  SE: Z('Europe/Stockholm'), NO: Z('Europe/Oslo'), FI: Z('Europe/Helsinki'), PL: Z('Europe/Warsaw'), CZ: Z('Europe/Prague'),
  SK: Z('Europe/Bratislava'), HU: Z('Europe/Budapest'), RO: Z('Europe/Bucharest'), BG: Z('Europe/Sofia'), GR: Z('Europe/Athens'),
  HR: Z('Europe/Zagreb'), SI: Z('Europe/Ljubljana'), RS: Z('Europe/Belgrade'), UA: Z('Europe/Kyiv'), BY: Z('Europe/Minsk'),
  LT: Z('Europe/Vilnius'), LV: Z('Europe/Riga'), EE: Z('Europe/Tallinn'), RU: Z('Europe/Moscow', true),
  US: Z('America/New_York', true), CA: Z('America/Toronto', true), MX: Z('America/Mexico_City', true),
  BR: Z('America/Sao_Paulo', true), AR: Z('America/Argentina/Buenos_Aires'), CL: Z('America/Santiago'),
  CO: Z('America/Bogota'), PE: Z('America/Lima'), EC: Z('America/Guayaquil'), VE: Z('America/Caracas'),
  PA: Z('America/Panama'), CR: Z('America/Costa_Rica'), GT: Z('America/Guatemala'), DO: Z('America/Santo_Domingo'),
  UY: Z('America/Montevideo'), PY: Z('America/Asuncion'), BO: Z('America/La_Paz'),
  AU: Z('Australia/Sydney', true), NZ: Z('Pacific/Auckland'),
  ZA: Z('Africa/Johannesburg'), EG: Z('Africa/Cairo'), NG: Z('Africa/Lagos'), KE: Z('Africa/Nairobi'), MA: Z('Africa/Casablanca'),
  DZ: Z('Africa/Algiers'), TN: Z('Africa/Tunis'), GH: Z('Africa/Accra'), ET: Z('Africa/Addis_Ababa'), TZ: Z('Africa/Dar_es_Salaam'),
}

/** 常见中英文名称 → ISO 码（小写比较，去空格与标点） */
const NAMES: Record<string, string> = {
  china: 'CN', 中国: 'CN', hongkong: 'HK', 香港: 'HK', 中国香港: 'HK', taiwan: 'TW', 台湾: 'TW', 中国台湾: 'TW',
  japan: 'JP', 日本: 'JP', korea: 'KR', southkorea: 'KR', 韩国: 'KR', singapore: 'SG', 新加坡: 'SG',
  malaysia: 'MY', 马来西亚: 'MY', thailand: 'TH', 泰国: 'TH', vietnam: 'VN', 越南: 'VN', philippines: 'PH', 菲律宾: 'PH',
  indonesia: 'ID', 印尼: 'ID', 印度尼西亚: 'ID', india: 'IN', 印度: 'IN', pakistan: 'PK', 巴基斯坦: 'PK',
  bangladesh: 'BD', 孟加拉: 'BD', 孟加拉国: 'BD', srilanka: 'LK', 斯里兰卡: 'LK',
  uae: 'AE', unitedarabemirates: 'AE', 阿联酋: 'AE', saudiarabia: 'SA', 沙特: 'SA', 沙特阿拉伯: 'SA', qatar: 'QA', 卡塔尔: 'QA',
  kuwait: 'KW', 科威特: 'KW', oman: 'OM', 阿曼: 'OM', israel: 'IL', 以色列: 'IL', turkey: 'TR', turkiye: 'TR', 土耳其: 'TR',
  iran: 'IR', 伊朗: 'IR', iraq: 'IQ', 伊拉克: 'IQ', kazakhstan: 'KZ', 哈萨克斯坦: 'KZ', uzbekistan: 'UZ', 乌兹别克斯坦: 'UZ',
  unitedkingdom: 'GB', greatbritain: 'GB', england: 'GB', britain: 'GB', 英国: 'GB', ireland: 'IE', 爱尔兰: 'IE',
  germany: 'DE', 德国: 'DE', france: 'FR', 法国: 'FR', italy: 'IT', 意大利: 'IT', spain: 'ES', 西班牙: 'ES',
  portugal: 'PT', 葡萄牙: 'PT', netherlands: 'NL', holland: 'NL', 荷兰: 'NL', belgium: 'BE', 比利时: 'BE',
  switzerland: 'CH', 瑞士: 'CH', austria: 'AT', 奥地利: 'AT', denmark: 'DK', 丹麦: 'DK', sweden: 'SE', 瑞典: 'SE',
  norway: 'NO', 挪威: 'NO', finland: 'FI', 芬兰: 'FI', poland: 'PL', 波兰: 'PL', czechia: 'CZ', czechrepublic: 'CZ', 捷克: 'CZ',
  hungary: 'HU', 匈牙利: 'HU', romania: 'RO', 罗马尼亚: 'RO', bulgaria: 'BG', 保加利亚: 'BG', greece: 'GR', 希腊: 'GR',
  croatia: 'HR', 克罗地亚: 'HR', serbia: 'RS', 塞尔维亚: 'RS', ukraine: 'UA', 乌克兰: 'UA', russia: 'RU', 俄罗斯: 'RU',
  unitedstates: 'US', usa: 'US', america: 'US', 美国: 'US', canada: 'CA', 加拿大: 'CA', mexico: 'MX', 墨西哥: 'MX',
  brazil: 'BR', brasil: 'BR', 巴西: 'BR', argentina: 'AR', 阿根廷: 'AR', chile: 'CL', 智利: 'CL', colombia: 'CO', 哥伦比亚: 'CO',
  peru: 'PE', 秘鲁: 'PE', ecuador: 'EC', 厄瓜多尔: 'EC', venezuela: 'VE', 委内瑞拉: 'VE', panama: 'PA', 巴拿马: 'PA',
  australia: 'AU', 澳大利亚: 'AU', 澳洲: 'AU', newzealand: 'NZ', 新西兰: 'NZ',
  southafrica: 'ZA', 南非: 'ZA', egypt: 'EG', 埃及: 'EG', nigeria: 'NG', 尼日利亚: 'NG', kenya: 'KE', 肯尼亚: 'KE',
  morocco: 'MA', 摩洛哥: 'MA', algeria: 'DZ', 阿尔及利亚: 'DZ', ghana: 'GH', 加纳: 'GH', ethiopia: 'ET', 埃塞俄比亚: 'ET',
}

export function zoneForCountry(country: string): Zone | null {
  const raw = country.trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper) && BY_CODE[upper]) return BY_CODE[upper]!
  const key = raw.normalize('NFKC').toLowerCase().replace(/[\s.\-_'’()]/g, '')
  const code = NAMES[key]
  return code ? (BY_CODE[code] ?? null) : null
}

export interface LocalTime {
  /** 24 小时制 HH:mm */
  text: string
  /** 当地 09:00–18:00 且周一到周五 */
  workHours: boolean
  approx: boolean
  tz: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz)!
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    formatters.set(tz, f)
    return f
  } catch {
    return null
  }
}

export function localTimeFor(country: string, now: number = Date.now()): LocalTime | null {
  const zone = zoneForCountry(country)
  if (!zone) return null
  const f = formatter(zone.tz)
  if (!f) return null
  const parts = f.formatToParts(new Date(now))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const hour = Number(get('hour'))
  const minute = get('minute')
  const weekday = get('weekday')
  const weekend = weekday === 'Sat' || weekday === 'Sun'
  return {
    text: `${String(hour).padStart(2, '0')}:${minute}`,
    workHours: !weekend && hour >= 9 && hour < 18,
    approx: Boolean(zone.multi),
    tz: zone.tz,
  }
}
