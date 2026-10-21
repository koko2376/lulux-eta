// 打开内核下拉后立刻截图（同一 CDP 会话内完成，避免被真实操作打断）
const fs = require('node:fs')

const port = process.argv[2]
const out = process.argv[3]

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const pages = targets.filter((t) => t.type === 'page')
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

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return res.result?.result?.value
  }

  await evaluate("location.hash = '#/agent'")
  await new Promise((r) => setTimeout(r, 700))
  const opened = await evaluate(`(async () => {
    const chip = document.querySelector('.kernel-chip')
    if (!chip) return 'no-chip'
    chip.click()
    await new Promise((r) => setTimeout(r, 350))
    return document.querySelector('.kernel-menu') ? 'open' : 'closed'
  })()`)
  console.log('menu:', opened)
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(out, Buffer.from(res.result.data, 'base64'))
  ws.close()
  console.log('saved', out)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
