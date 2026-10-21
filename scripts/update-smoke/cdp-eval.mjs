#!/usr/bin/env node
// 在 Electron 主窗口页面里执行一段表达式（Chrome DevTools Protocol，应用以 --remote-debugging-port 启动），打印 JSON 结果。
//   node scripts/update-smoke/cdp-eval.mjs <调试端口> '<表达式>'
// 用于冒烟：经 preload 的 window.lulux.updater 走真实 IPC（含来源校验），而不是在主进程里直接调用。
const [port, expression] = process.argv.slice(2)
if (!port || !expression) {
  console.error('用法：cdp-eval.mjs <port> <expression>')
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
if (!page) {
  console.error('没有找到应用页面', JSON.stringify(targets.map((t) => [t.type, t.url])))
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
// 页面可能在返回前就关闭（例如 install() 让应用退出）：连接关闭或 20 秒超时都视为“无返回值”
const reply = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ result: { result: { value: null } } }), 20_000)
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id === 1) {
      clearTimeout(timer)
      resolve(message)
    }
  }
  ws.onclose = () => {
    clearTimeout(timer)
    resolve({ result: { result: { value: '(page closed)' } } })
  }
})
ws.close()
const result = reply.result
if (result?.exceptionDetails) {
  console.log(JSON.stringify({ error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }))
  process.exit(1)
}
console.log(JSON.stringify(result?.result?.value ?? null))
