// 桌面端“连接团队服务器”验收（契约 5.10）：通过 CDP 在渲染进程里调用 window.luluxAgent.api，
// 验证模式切换、CSP connect-src 放行、跨源登录（CORS）、会话保存与读取。
// 用法：node tools/dev/remote-mode-check.js <cdp端口> <团队服务器地址> <邮箱> <密码>
const http = require('node:http')

const [port = '9335', serverUrl, email, password] = process.argv.slice(2)
if (!serverUrl || !email || !password) {
  console.error('用法：node tools/dev/remote-mode-check.js <cdp端口> <团队服务器地址> <邮箱> <密码>')
  process.exit(2)
}

function targets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/json`, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(JSON.parse(body).filter((t) => t.type === 'page' && /^https?:/.test(t.url))))
      })
      .on('error', reject)
  })
}

async function evaluate(expression) {
  const [target] = await targets()
  if (!target) throw new Error('没有找到应用页面')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== 1) return
      ws.close()
      if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails)))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = (e) => reject(new Error(e.message || 'ws error'))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}

async function main() {
  const initial = await evaluate(`({ mode: window.luluxAgent.api.mode, baseUrl: window.luluxAgent.api.baseUrl, hasToken: window.luluxAgent.apiToken.length === 64 })`)
  check('初始为本地模式且有本机 token', initial.mode === 'local' && initial.hasToken, initial)

  const bad = await evaluate(`window.luluxAgent.api.connectRemote('http://example.com')`)
  check('拒绝非 https 的远程地址', bad.ok === false, bad.error)

  const connected = await evaluate(`window.luluxAgent.api.connectRemote(${JSON.stringify(serverUrl)})`)
  check('connectRemote 校验 /api/auth/mode 成功', connected.ok === true, connected)
  await sleep(2500)

  const remote = await evaluate(`({ mode: window.luluxAgent.api.mode, baseUrl: window.luluxAgent.api.baseUrl, apiToken: window.luluxAgent.apiToken })`)
  check('重新加载后进入远程模式，本机 token 不暴露', remote.mode === 'remote' && remote.baseUrl === new URL(serverUrl).origin && remote.apiToken === '', remote)

  const csp = await evaluate(`fetch(location.href).then(r => r.headers.get('content-security-policy'))`)
  void csp
  const login = await evaluate(`fetch(${JSON.stringify(serverUrl)} + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }) }).then(async r => ({ status: r.status, body: await r.json() }))`)
  check('渲染进程跨源登录团队服务器（CSP + CORS 放行）', login.status === 200 && /^lxs_/.test(login.body.token), { status: login.status, user: login.body.user && login.body.user.email })

  await evaluate(`window.luluxAgent.api.setSession(${JSON.stringify({ token: login.body.token, user: login.body.user })})`)
  const session = await evaluate(`window.luluxAgent.api.getSession()`)
  check('setSession / getSession 返回远程会话', session.mode === 'remote' && session.token === login.body.token && session.user.email === email, { mode: session.mode, user: session.user && session.user.email })

  const me = await evaluate(`window.luluxAgent.api.getSession().then(s => fetch(s.baseUrl + '/api/auth/me', { headers: { Authorization: 'Bearer ' + s.token } })).then(r => r.json())`)
  check('用会话 token 调用 /api/auth/me', me.user && me.user.email === email, me.user && me.user.role)

  const blocked = await evaluate(`fetch('https://example.com/').then(() => 'allowed', () => 'blocked')`)
  check('其他 origin 仍被 CSP 拦截', blocked === 'blocked', blocked)

  await evaluate(`window.luluxAgent.api.useLocal()`)
  await sleep(2500)
  const local = await evaluate(`window.luluxAgent.api.getSession().then(s => ({ mode: s.mode, tokenIsLocal: s.token === window.luluxAgent.apiToken && s.token.length === 64 }))`)
  check('useLocal 切回本地模式', local.mode === 'local' && local.tokenIsLocal, local)

  const conn = await evaluate(`window.luluxAgent.api.getConnection()`)
  check('最近服务器列表已记录', conn.recentServers.includes(new URL(serverUrl).origin), conn)

  await evaluate(`window.luluxAgent.api.connectRemote(${JSON.stringify(serverUrl)})`)
  await sleep(2500)
  const again = await evaluate(`window.luluxAgent.api.getSession()`)
  check('切回远程模式后会话仍在（免登录）', again.token === login.body.token, { mode: again.mode })

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `全部 ${results.length} 项通过` : `${failed.length} 项失败`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
