// 通过 CDP 截取页面本身（不含其他窗口遮挡）
const fs = require('node:fs')

const port = process.argv[2]
const out = process.argv[3]

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const pages = targets.filter((t) => t.type === 'page')
  // 内置浏览器标签也是 page，优先截应用本身（http 页面）
  const page = pages.find((t) => /^https?:/.test(t.url)) ?? pages[0]
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(out, Buffer.from(res.result.data, 'base64'))
  ws.close()
  console.log('saved', out)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
