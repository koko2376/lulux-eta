import { E2E_LOCAL, LOCAL_SESSION_ENV } from './local-account'

/** 在 desktop 服务上创建（或复用时登录）e2e 本机账户，会话 token 交给 workers（process.env） */
export default async function globalSetup(): Promise<void> {
  const base = `http://localhost:${process.env.E2E_PORT_WEB || 52790}`
  const post = (path: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...E2E_LOCAL, remember: true }),
    })
  let res = await post('/api/auth/local/accounts')
  // E2E_MOCK=1 的契约 mock 没有本机账户接口：客户端照旧直接进入
  if (res.status === 404) return
  if (res.status === 403 || res.status === 409) res = await post('/api/auth/local/login')
  if (!res.ok) throw new Error(`e2e 本机账户创建失败：${res.status} ${await res.text()}`)
  const { token } = (await res.json()) as { token: string }
  process.env[LOCAL_SESSION_ENV] = token
}
