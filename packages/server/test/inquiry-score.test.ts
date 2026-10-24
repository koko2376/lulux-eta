import { describe, expect, it } from 'vitest'
import { detectLanguage, scoreInquiry, type InquiryInput } from '../src/services/email/inquiry-score.js'
import { FREE_MAIL_DOMAINS } from '../src/services/email/presets.js'

/** 询盘打分纯函数：真实风格的询盘样本，逐条看分数、等级、标记、追问项。 */

const base = (extra: Partial<InquiryInput>): InquiryInput => ({
  fromAddress: 'buyer@example.com',
  subject: '',
  body: '',
  freeMailDomains: FREE_MAIL_DOMAINS,
  ...extra,
})

const keys = (r: { reasons: Array<{ key: string }> }) => r.reasons.map((x) => x.key)

describe('scoreInquiry', () => {
  it('具体的公司询盘：A 级，不再追问已说清的点', () => {
    const r = scoreInquiry(
      base({
        fromAddress: 'j.miller@northwind-pumps.co.uk',
        fromName: 'James Miller',
        subject: 'RFQ - Gate valves DN50 PN16, 2000 pcs',
        body:
          'Dear Sales,\n\nWe are looking for ductile iron gate valves DN50 PN16, quantity 2000 pcs for the first order, ' +
          'CIF Felixstowe. Our target price is USD 9.50 per piece and we need delivery before March.\n\n' +
          'Best regards,\nJames Miller\nPurchasing Manager\nNorthwind Pumps Ltd\nTel: +44 20 7946 0958\nwww.northwind-pumps.co.uk',
      }),
    )
    expect(r.grade).toBe('A')
    expect(r.score).toBeGreaterThanOrEqual(90)
    expect(keys(r)).toEqual(expect.arrayContaining(['company_domain', 'quantity', 'product', 'terms', 'target_price', 'lead_time', 'signature']))
    expect(r.flags).toEqual([])
    expect(r.followUps).toEqual([])
    expect(r.language).toBe('en')
  })

  it('Gmail + 只要样品不提数量：索样党，D/C 级，追问公司和官网', () => {
    const r = scoreInquiry(
      base({
        fromAddress: 'bestbuyer2026@gmail.com',
        subject: 'sample',
        body: 'Hello, I am interested in your products. Please send me free samples. Thanks',
      }),
    )
    expect(r.flags).toEqual(expect.arrayContaining(['free_mail', 'sample_hunter']))
    expect(['C', 'D']).toContain(r.grade)
    expect(r.score).toBeLessThan(40)
    expect(r.followUps.join()).toContain('公司名称和官网')
  })

  it('只要目录和价格表：vague 扣分，追问品名和数量', () => {
    const r = scoreInquiry(base({ fromAddress: 'info@globaltrade-imports.com', subject: 'Catalogue', body: 'Please send your latest catalogue and price list.' }))
    expect(r.flags).toContain('vague')
    expect(keys(r)).not.toContain('short')
    expect(r.followUps[0]).toContain('品名')
    expect(r.grade).toBe('C')
  })

  it('钓鱼：点链接看订单 + html 附件 → 封顶 25 分（D），即使用公司域名', () => {
    const r = scoreInquiry(
      base({
        fromAddress: 'purchase@buyer-company.com',
        subject: 'New Purchase Order #4471',
        body: 'Please click here to view the purchase order online: https://docs-share.web.app/po4471 . Quantity 5000 pcs. Regards, Buyer Company Ltd, Tel: +1 555 0100 222',
        attachmentNames: ['PO_4471.html'],
      }),
    )
    expect(r.flags).toContain('phishing')
    expect(r.score).toBeLessThanOrEqual(25)
    expect(r.grade).toBe('D')
  })

  it('免费托管 / 短链配“订单”字样算钓鱼；常见网盘发图纸只轻微提醒；普通官网链接不算', () => {
    expect(scoreInquiry(base({ body: 'Our order details are here https://po-view.web.app/abc please check' })).flags).toContain('phishing')
    const cloud = scoreInquiry(base({ body: 'Drawings for the order: https://www.dropbox.com/s/abc/valve.pdf , 300 pcs DN40' }))
    expect(cloud.flags).not.toContain('phishing')
    expect(keys(cloud)).toContain('cloud_link')
    expect(scoreInquiry(base({ body: 'See our company https://www.example.com for the drawing of the order, 300 pcs DN40' })).flags).not.toContain('phishing')
  })

  it('付款诈骗：改收款账户 → 封顶 35', () => {
    const r = scoreInquiry(
      base({
        fromAddress: 'accounts@acme-valves.de',
        existingCustomer: true,
        subject: 'Payment',
        body: 'Please note the change of bank details, kindly make the urgent payment to our new bank account below.',
      }),
    )
    expect(r.flags).toContain('payment_fraud')
    expect(r.score).toBeLessThanOrEqual(35)
  })

  it('回复地址换了域名：扣分并标记；同公司子域名不算', () => {
    const bad = scoreInquiry(base({ fromAddress: 'sales@acme-valves.de', replyTo: ['acme.valves@outlook.com'], body: 'Need 500 pcs DN25' }))
    expect(bad.flags).toContain('reply_to_mismatch')
    const ok = scoreInquiry(base({ fromAddress: 'sales@mail.acme.co.uk', replyTo: ['john@acme.co.uk'], body: 'Need 500 pcs DN25' }))
    expect(ok.flags).not.toContain('reply_to_mismatch')
  })

  it('已有客户加分；制裁命中封顶 D 并写明名单名', () => {
    const repeat = scoreInquiry(base({ fromAddress: 'p@acme-valves.de', existingCustomer: true, body: 'Repeat order 300 pcs DN25 please' }))
    expect(keys(repeat)).toContain('existing_customer')
    expect(repeat.grade === 'A' || repeat.grade === 'B').toBe(true)
    const hit = scoreInquiry(base({ fromAddress: 'p@rosneft-trade.ru', sanctionsHit: 'ROSNEFT TRADING', body: 'We need 10 containers 40HQ' }))
    expect(hit.flags).toContain('sanctions_hit')
    expect(hit.grade).toBe('D')
    expect(hit.reasons.find((r) => r.key === 'sanctions_hit')!.label).toContain('ROSNEFT TRADING')
  })

  it('非英语询盘：识别语种并能识别数量', () => {
    const es = scoreInquiry(base({ fromAddress: 'compras@ferreteria-sol.es', body: 'Hola, necesitamos cotización de 800 piezas de válvulas de bola, precio FOB. Saludos' }))
    expect(es.language).toBe('es')
    expect(es.asks.incoterm).toBe(true)
    const ru = scoreInquiry(base({ fromAddress: 'zakupki@stroy-torg.ru', body: 'Здравствуйте! Нам нужно 500 шт шаровых кранов DN25. Пришлите цену.' }))
    expect(ru.language).toBe('ru')
    expect(ru.asks.quantity).toBe(true)
    const zh = scoreInquiry(base({ fromAddress: 'cg@example.cn', body: '你好，我们需要 300 台水泵，型号 QJ-50，请报 FOB 宁波价格。' }))
    expect(zh.language).toBe('zh')
    expect(zh.asks.quantity && zh.asks.product).toBe(true)
  })

  it('分数在 0–100 之间；等级边界', () => {
    const worst = scoreInquiry(base({ fromAddress: 'x@gmail.com', replyTo: ['y@yahoo.com'], body: 'verify your account. free samples. western union', attachmentNames: ['a.exe'] }))
    expect(worst.score).toBeGreaterThanOrEqual(0)
    expect(worst.grade).toBe('D')
  })
})

describe('detectLanguage', () => {
  it.each([
    ['Bonjour, nous avons besoin d’un devis pour 200 pièces. Cordialement', 'fr'],
    ['Sehr geehrte Damen und Herren, wir benötigen ein Angebot. Mit freundlichen Grüßen', 'de'],
    ['Olá, prezados, precisamos de cotação. Atenciosamente', 'pt'],
    ['お世話になっております。見積もりをお願いします。', 'ja'],
    ['안녕하세요. 견적 부탁드립니다.', 'ko'],
    ['مرحبا، نحتاج إلى عرض سعر', 'ar'],
    ['Merhaba, fiyat teklifi rica ederiz. Saygılarımızla', 'tr'],
    ['Dear Sir, please quote', 'en'],
    ['您好，我们想采购一批不锈钢球阀，品牌是サンワ和ミツビシ的同款，数量五百个，请报价，谢谢。我们在宁波，希望尽快交货。', 'zh'],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang)
  })
})
