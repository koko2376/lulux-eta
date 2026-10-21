const http = require('node:http')

const port = process.argv[2] || '9333'
const expr = process.argv[3] || 'location.href'

http.get(`http://127.0.0.1:${port}/json`, (res) => {
  let body = ''
  res.on('data', (c) => (body += c))
  res.on('end', () => {
    const all = JSON.parse(body).filter((t) => t.type === 'page')
    // 内置浏览器标签也是一个 page target，优先选应用本身（http 页面）
    const targets = all.filter((t) => /^https?:/.test(t.url)).length
      ? all.filter((t) => /^https?:/.test(t.url))
      : all
    if (!targets.length) {
      console.log('no page target')
      return
    }
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === 1) {
        console.log(JSON.stringify(msg.result?.result?.value ?? msg.result, null, 2))
        ws.close()
      }
    }
    ws.onerror = (e) => {
      console.log('ws error', e.message || e)
    }
  })
})
