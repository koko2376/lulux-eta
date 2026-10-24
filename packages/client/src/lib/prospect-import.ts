import type { ProspectImportField } from '../api'

/** 表头同义词（小写、去空格和符号后匹配） */
const SYNONYMS: Record<ProspectImportField, string[]> = {
  company: ['company', 'companyname', 'importer', 'buyer', 'consignee', 'customer', '公司', '公司名称', '企业名称', '进口商', '买家', '收货人', '客户'],
  country: ['country', 'countrycode', 'region', 'nation', '国家', '地区', '国家地区'],
  website: ['website', 'web', 'url', 'site', 'homepage', 'domain', '网站', '官网', '网址', '域名'],
  address: ['address', 'addr', 'location', '地址', '公司地址'],
  products: ['products', 'product', 'goods', 'description', 'productdescription', '产品', '主营', '主营产品', '货物描述', '品名'],
  hsCodes: ['hs', 'hscode', 'hscodes', 'hts', 'commodity', 'commoditycode', '海关编码', 'hs编码', '税号'],
  emails: ['email', 'emails', 'e-mail', 'mail', '邮箱', '电子邮件'],
  phones: ['phone', 'phones', 'tel', 'telephone', 'mobile', '电话', '手机'],
  notes: ['notes', 'note', 'remark', 'remarks', 'comment', '备注', '说明'],
}
const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()（）:：/]/g, '')

export function guessProspectMapping(headers: string[]): Partial<Record<ProspectImportField, string>> {
  const out: Partial<Record<ProspectImportField, string>> = {}
  const used = new Set<string>()
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of Object.keys(SYNONYMS) as ProspectImportField[]) {
      if (out[field]) continue
      const hit = headers.find((h) => {
        if (used.has(h)) return false
        const n = norm(h)
        return pass === 'exact' ? SYNONYMS[field].includes(n) : SYNONYMS[field].some((syn) => syn.length > 2 && n.includes(syn))
      })
      if (hit) {
        out[field] = hit
        used.add(hit)
      }
    }
  }
  return out
}

