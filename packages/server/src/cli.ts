/**
 * 服务器管理命令（契约 5.3）：
 *   node dist/cli.js create-owner --email a@b.com --password '…' --name Koko --org '某某外贸'
 *   node dist/cli.js reset-password --email a@b.com --password '…'
 *   node dist/cli.js reset-password --username koko --password '…'   （桌面版本机账户）
 * 读取与服务相同的环境变量（LULUX_ETA_HOME、LULUX_MASTER_KEY…）。可在服务运行时执行（SQLite WAL）。
 */
import { parseArgs } from 'node:util'

function fail(message: string): never {
  console.error(`错误：${message}`)
  process.exit(1)
}

const USAGE = `用法：
  lulux-cli create-owner --email <邮箱> --password <密码> --name <姓名> --org <组织名>
  lulux-cli reset-password --email <邮箱> --password <新密码>
  lulux-cli reset-password --username <本机用户名> --password <新密码>   （桌面版本机账户，需与 LULUX 使用同一数据目录）`

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
      org: { type: 'string' },
    },
    strict: true,
  })
  const { db } = await import('./db.js')
  const { authService } = await import('./services/auth-service.js')
  const { AppError } = await import('./errors.js')
  try {
    if (command === 'create-owner') {
      if (!values.email || !values.password || !values.name || !values.org) fail(`缺少参数\n${USAGE}`)
      const row = await authService.createOwner({
        email: values.email.trim().toLowerCase(),
        password: values.password,
        name: values.name.trim(),
        orgName: values.org.trim(),
      })
      console.log(`已创建 owner：${row.email}（组织「${values.org}」）。现在可以用该账号登录。`)
      return
    }
    if (command === 'reset-password' && values.username !== undefined) {
      if (values.email) fail(`--email 与 --username 只能二选一\n${USAGE}`)
      if (!values.username.trim() || !values.password) fail(`缺少参数\n${USAGE}`)
      const { localAuthService } = await import('./services/local-auth-service.js')
      const result = await localAuthService.resetPasswordFromCli(values.username, values.password)
      console.log(`本机账户 ${result.username} 的密码已重置，这个账户的所有登录已失效。`)
      console.log(`新的恢复码（旧的已作废，请妥善保存）：${result.recoveryCode}`)
      return
    }
    if (command === 'reset-password') {
      if (!values.email || !values.password) fail(`缺少参数\n${USAGE}`)
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(values.email.trim().toLowerCase()) as { id: string } | undefined
      if (!row) fail('该邮箱没有账号')
      await authService.resetPassword(row.id, values.password)
      console.log('密码已重置，该用户的所有会话已失效。')
      return
    }
    fail(`未知命令 ${command}\n${USAGE}`)
  } catch (error) {
    if (error instanceof AppError) fail(`${error.message}（${error.code}）`)
    throw error
  }
}

void main()
