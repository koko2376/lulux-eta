/**
 * 国家 → 主要商业时区（开发信按对方工作时间发送用）。跨多个时区的国家取商业中心所在时区（美国取纽约、俄罗斯取莫斯科等）；
 * 需要更准时，可以给单个联系人单独指定时区。
 */
export const COUNTRY_TZ: Record<string, string> = {
  US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago', CO: 'America/Bogota', PE: 'America/Lima', EC: 'America/Guayaquil', VE: 'America/Caracas', UY: 'America/Montevideo',
  PY: 'America/Asuncion', BO: 'America/La_Paz', PA: 'America/Panama', CR: 'America/Costa_Rica', GT: 'America/Guatemala', DO: 'America/Santo_Domingo',
  JM: 'America/Jamaica', TT: 'America/Port_of_Spain', PR: 'America/Puerto_Rico', HN: 'America/Tegucigalpa', SV: 'America/El_Salvador', NI: 'America/Managua',
  GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris', DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', LU: 'Europe/Luxembourg',
  CH: 'Europe/Zurich', AT: 'Europe/Vienna', IT: 'Europe/Rome', ES: 'Europe/Madrid', PT: 'Europe/Lisbon', DK: 'Europe/Copenhagen', SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo', FI: 'Europe/Helsinki', IS: 'Atlantic/Reykjavik', PL: 'Europe/Warsaw', CZ: 'Europe/Prague', SK: 'Europe/Bratislava', HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest', BG: 'Europe/Sofia', GR: 'Europe/Athens', HR: 'Europe/Zagreb', SI: 'Europe/Ljubljana', RS: 'Europe/Belgrade', BA: 'Europe/Sarajevo',
  MK: 'Europe/Skopje', AL: 'Europe/Tirane', EE: 'Europe/Tallinn', LV: 'Europe/Riga', LT: 'Europe/Vilnius', UA: 'Europe/Kyiv', MD: 'Europe/Chisinau',
  BY: 'Europe/Minsk', RU: 'Europe/Moscow', TR: 'Europe/Istanbul', CY: 'Asia/Nicosia', MT: 'Europe/Malta', GE: 'Asia/Tbilisi', AM: 'Asia/Yerevan',
  AZ: 'Asia/Baku', KZ: 'Asia/Almaty', UZ: 'Asia/Tashkent', KG: 'Asia/Bishkek', TJ: 'Asia/Dushanbe', TM: 'Asia/Ashgabat', MN: 'Asia/Ulaanbaatar',
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', OM: 'Asia/Muscat', YE: 'Asia/Aden', IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran', IL: 'Asia/Jerusalem', JO: 'Asia/Amman', LB: 'Asia/Beirut', SY: 'Asia/Damascus', EG: 'Africa/Cairo', LY: 'Africa/Tripoli',
  TN: 'Africa/Tunis', DZ: 'Africa/Algiers', MA: 'Africa/Casablanca', NG: 'Africa/Lagos', GH: 'Africa/Accra', CI: 'Africa/Abidjan', SN: 'Africa/Dakar',
  CM: 'Africa/Douala', KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala', ET: 'Africa/Addis_Ababa', RW: 'Africa/Kigali',
  ZA: 'Africa/Johannesburg', AO: 'Africa/Luanda', MZ: 'Africa/Maputo', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare', NA: 'Africa/Windhoek', BW: 'Africa/Gaborone',
  MU: 'Indian/Mauritius', MG: 'Indian/Antananarivo', SD: 'Africa/Khartoum', CD: 'Africa/Kinshasa', BJ: 'Africa/Porto-Novo', TG: 'Africa/Lome',
  PK: 'Asia/Karachi', IN: 'Asia/Kolkata', BD: 'Asia/Dhaka', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu', AF: 'Asia/Kabul', MV: 'Indian/Maldives',
  CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau', TW: 'Asia/Taipei', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', VN: 'Asia/Ho_Chi_Minh',
  TH: 'Asia/Bangkok', MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore', ID: 'Asia/Jakarta', PH: 'Asia/Manila', MM: 'Asia/Yangon', KH: 'Asia/Phnom_Penh',
  LA: 'Asia/Vientiane', BN: 'Asia/Brunei', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', FJ: 'Pacific/Fiji', PG: 'Pacific/Port_Moresby',
}

let nameIndex: Map<string, string> | null = null

function buildIndex(): Map<string, string> {
  const index = new Map<string, string>()
  const add = (name: string | undefined, code: string) => {
    if (name) index.set(name.trim().toLowerCase(), code)
  }
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt', 'ru']) {
    let names: Intl.DisplayNames
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' })
    } catch {
      continue
    }
    for (const code of Object.keys(COUNTRY_TZ)) add(names.of(code), code)
  }
  const aliases: Record<string, string> = {
    usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US', 'united states of america': 'US', uk: 'GB', 'u.k.': 'GB', england: 'GB',
    britain: 'GB', 'great britain': 'GB', scotland: 'GB', wales: 'GB', uae: 'AE', 'u.a.e.': 'AE', emirates: 'AE', korea: 'KR', 'south korea': 'KR',
    russia: 'RU', holland: 'NL', 'the netherlands': 'NL', turkiye: 'TR', 'türkiye': 'TR', vietnam: 'VN', 'viet nam': 'VN', 'ivory coast': 'CI',
    美国: 'US', 英国: 'GB', 德国: 'DE', 法国: 'FR', 俄罗斯: 'RU', 韩国: 'KR', 阿联酋: 'AE', 越南: 'VN', 中国香港: 'HK', 香港: 'HK',
  }
  for (const [name, code] of Object.entries(aliases)) add(name, code)
  return index
}

/** 把国家（ISO2 代码、英文 / 中文等常见名称）解析成 ISO2；认不出返回 null */
export function countryCode(input: string | null | undefined): string | null {
  const text = (input ?? '').trim()
  if (!text) return null
  const upper = text.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper) && COUNTRY_TZ[upper]) return upper
  // 两个字母但不是 ISO 码（如 UK）：再按别名查
  nameIndex ??= buildIndex()
  return nameIndex.get(text.toLowerCase()) ?? null
}

/** 国家 → 时区；认不出返回 null */
export function timezoneForCountry(input: string | null | undefined): string | null {
  const code = countryCode(input)
  return code ? COUNTRY_TZ[code]! : null
}
