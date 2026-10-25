// 端到端 / 截图用的 OpenAI 兼容假模型：按系统提示词区分“邮件分拣”“写信助手”与普通对话。
// 用法：node e2e/fixtures/mock-llm.mjs [port=52999]
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 52999)

const DRAFT = `Dear Hans,

Thank you for your RFQ for brass ball valves.

Please find our offer below (FOB Ningbo, valid for 30 days):
- DN25 PN16 full bore, lever handle: USD 3.85 / pc × 2,000 pcs
- DN32 PN16 full bore: USD 5.60 / pc × 800 pcs

Both items are CE marked; DVGW certificate is available on request. MOQ is 500 pcs per size,
and lead time is 25 days after deposit. The detailed quotation is attached as PDF.

Looking forward to your feedback.`

function reply(body) {
  const system = String(body.messages?.[0]?.content ?? '')
  const last = body.messages?.[body.messages.length - 1]
  if (system.includes('邮件分拣')) return '{"verdict":"inquiry","reason":"进口商索要产品目录与价格表，属于潜在询盘"}'
  if (system.includes('写信助手')) return DRAFT
  // 群聊主管：派发后的分工说明 / 最终汇总
  if (system.includes('你是本群聊的主管') && last?.role === 'tool') return SUPERVISOR_PLAN
  if (system.includes('请给出最终汇总')) return SUPERVISOR_SUMMARY
  const speaker = (system.match(/只代表「([^」]+)」/) || [])[1]
  if (speaker && GROUP[speaker]) return GROUP[speaker]
  if (last?.role === 'tool') return QUOTE
  const text = String(last?.content ?? '')
  if (/报价|quote/i.test(text)) return QUOTE
  return `收到：「${text.slice(0, 40)}」。我先查一下客户资料，再给你一版回信要点：\n\n1. 确认数量与贸易条款（FOB Ningbo）\n2. 报出阶梯价并说明认证\n3. 附上报价单 PDF`
}

/** 演示用推理过程（DeepSeek/Qwen 风格 reasoning_content） */
const THINK = {
  LULUX:
    '对方 2,800 只、关注 DVGW；去年德国同类成交价 USD 4.0 左右，汉堡分销商近两季 DN25 CE 款集中在 3.70–4.20。走量款压到 3.85，再留 3% 谈判空间。',
  quote: '先查客户资料：Nordlicht 是汉堡的阀门分销商，正在谈判阶段，关注 DVGW 认证。按 FOB 宁波、25 天交期给阶梯价。',
}

/** 群聊主管（规划阶段）：提供了 dispatch_members 工具、还没有工具结果时，派发给全部可派发成员 */
function dispatchTargets(body) {
  if (!Array.isArray(body.tools) || hasToolResult(body)) return null
  const tool = body.tools.find((t) => t.function?.name === 'dispatch_members')
  return tool ? (tool.function.parameters?.properties?.members?.items?.enum ?? []) : null
}

const SUPERVISOR_PLAN = '这个问题需要代码与文档能力，我请 Claude Code 先给出方案，稍后我来汇总。'
const SUPERVISOR_SUMMARY = [
  '**汇总**：',
  '',
  '| 事项 | 结论 | 负责人 |',
  '| --- | --- | --- |',
  '| 报价 | DN25 报 USD 3.85，留 3% 谈判空间 | 业务 |',
  '| 认证 | 今天确认 DVGW 证书有效期 | 质检 |',
  '| 跟进 | 3 天未回复电话跟进 | 业务 |',
].join('\n')

function hasToolResult(body) {
  return (body.messages ?? []).some((m) => m.role === 'tool')
}

const GROUP = {
  LULUX: [
    '整体意见如下：',
    '',
    '1. **报价**：DN25 走量款报 **USD 3.85/pc**，比去年德国同类成交价低 4%，留 3% 谈判空间；DN32 报 USD 5.60。',
    '2. **竞品**：汉堡与不来梅分销商近半年采购价集中在 USD 3.70–4.20（DN25，CE 认证），意大利、土耳其货交期 35–45 天——我们 25 天交期是明确卖点。',
    '3. **下一步**：今天确认 DVGW 证书有效期；明天上午发报价单 + 认证扫描件；3 天后未回复则电话跟进。',
    '4. **回信**：先感谢、直接给价格，第二段讲认证和交期，结尾给出样品安排。',
  ].join('\n'),
}

const QUOTE = [
  '好的，按 Nordlicht Armaturen 的询价整理了一版报价：',
  '',
  '- DN25 PN16 全通径黄铜球阀 × 2,000：USD 3.85',
  '- DN32 PN16 全通径黄铜球阀 × 800：USD 5.60',
  '- FOB Ningbo，定金后 25 天交货，CE 认证',
  '',
  '```html',
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quotation Q-2026-0142</title>',
  '<style>body{font:13px/1.6 system-ui;padding:28px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:7px 9px;text-align:left}th{background:#f5f5f7}h1{font-size:17px;margin:0 0 4px}.r{text-align:right}</style></head><body>',
  '<h1>Quotation Q-2026-0142</h1><p>To: Nordlicht Armaturen GmbH · Hamburg · FOB Ningbo</p>',
  '<table><tr><th>Item</th><th>Qty</th><th class="r">Unit (USD)</th><th class="r">Amount</th></tr>',
  '<tr><td>Brass ball valve DN25 PN16</td><td>2,000</td><td class="r">3.85</td><td class="r">7,700.00</td></tr>',
  '<tr><td>Brass ball valve DN32 PN16</td><td>800</td><td class="r">5.60</td><td class="r">4,480.00</td></tr>',
  '<tr><th colspan="3">Total</th><th class="r">12,180.00</th></tr></table><p>Valid 30 days · Lead time 25 days after deposit.</p></body></html>',
  '```',
  '',
  '需要的话我可以把它存成该客户的正式报价单，或起草一封回信草稿（发送仍需你确认）。',
].join('\n')

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }] }))
    }
    res.writeHead(404).end('not found')
    return
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}')
    const system = String(body.messages?.[0]?.content ?? '')
    const lastText = String(body.messages?.[body.messages.length - 1]?.content ?? '')
    const speaker = (system.match(/只代表「([^」]+)」/) || [])[1]
    // 普通对话里的报价请求：先调用一次业务工具 search_customers，再基于结果回答（演示工具调用轨迹）
    const wantsTool =
      body.stream !== false &&
      !speaker &&
      Array.isArray(body.tools) &&
      body.tools.some((t) => t.function?.name === 'search_customers') &&
      /报价|quote/i.test(lastText) &&
      !hasToolResult(body)
    const dispatchTo = body.stream !== false ? dispatchTargets(body) : null
    const reasoning = dispatchTo
      ? ''
      : body.stream === false
        ? ''
        : speaker
          ? (THINK[speaker] ?? '')
          : /报价|quote/i.test(lastText) || hasToolResult(body)
            ? THINK.quote
            : ''
    const text = wantsTool || dispatchTo ? '' : reply(body)
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }),
      )
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    const send = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
    if (reasoning && !hasToolResult(body)) {
      for (const piece of reasoning.match(/[\s\S]{1,24}/g) ?? []) send({ reasoning_content: piece })
    }
    if (dispatchTo) {
      const args = JSON.stringify({ members: dispatchTo, instructions: '请给出可执行的方案，要点用列表。' })
      send({
        tool_calls: [
          { index: 0, id: 'call_dispatch_1', type: 'function', function: { name: 'dispatch_members', arguments: '' } },
        ],
      })
      send({ tool_calls: [{ index: 0, function: { arguments: args } }] })
      send({}, 'tool_calls')
    } else if (wantsTool) {
      send({
        tool_calls: [
          { index: 0, id: 'call_demo_1', type: 'function', function: { name: 'search_customers', arguments: '' } },
        ],
      })
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: 'Nordlicht' }) } }] })
      send({}, 'tool_calls')
    } else {
      for (const piece of text.match(/[\s\S]{1,32}/g) ?? []) {
        send({ content: piece })
        await new Promise((r) => setTimeout(r, 8))
      }
      send({}, 'stop')
    }
    if (body.stream_options?.include_usage) {
      const prompt = Math.round(JSON.stringify(body.messages ?? []).length / 3)
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: Math.round((text.length + reasoning.length) / 2) + 12, prompt_tokens_details: { cached_tokens: Math.floor(prompt / 2) } } })}\n\n`,
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] on ${PORT}`))
