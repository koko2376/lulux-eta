import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Browser, type BrowserContext } from '@playwright/test'

/**
 * 登录页（desktop 模式的本机服务）：LULUX（本机）| 云端 LULUX（连接服务器）分段开关，接真实行为。
 * LULUX：用户名 + 密码（本机账户）；云端 LULUX：服务器地址 + 邮箱 + 密码。
 * 团队服务器登录（同源 server 模式）见 team.spec.ts；本机锁 PIN 见 flow.spec.ts。
 */
test.describe.configure({ mode: 'serial' })

const LOCAL = { username: 'Koko', password: 'correct horse 2026' }
/** 创建账户时显示的一次性恢复码（忘记密码用例要用） */
let recoveryCode = ''
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/

/**
 * 这个文件要从“没有本机账户”开始（全新安装）。其他用例共用 globalSetup 建的 e2e 账户：
 * 开头把本机账户 / 会话整表备份后清空，结束时原样放回（e2e 账户的会话 token 继续有效）。
 * 这里也不带 extraHTTPHeaders 的 e2e 会话，完全走真实的登录页。
 */
test.use({ extraHTTPHeaders: {} })
type Rows = Record<string, unknown>[]
let saved: { accounts: Rows; sessions: Rows } | null = null
function openDb(): DatabaseSync | null {
  const dir = process.env.E2E_DATA_DIR
  return dir ? new DatabaseSync(join(dir, 'lulux-eta.db')) : null
}
function dropLocalAccounts(): void {
  const db = openDb()
  if (!db) return
  try {
    db.exec('DELETE FROM local_sessions; DELETE FROM local_accounts;')
  } finally {
    db.close()
  }
}
function insertAll(db: DatabaseSync, table: string, rows: Rows): void {
  for (const row of rows) {
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...(cols.map((c) => row[c]) as never[]),
    )
  }
}
test.beforeAll(() => {
  const db = openDb()
  if (!db) return
  try {
    saved = {
      accounts: db.prepare('SELECT * FROM local_accounts').all() as Rows,
      sessions: db.prepare('SELECT * FROM local_sessions').all() as Rows,
    }
  } finally {
    db.close()
  }
  dropLocalAccounts()
})
test.afterAll(() => {
  dropLocalAccounts()
  const db = openDb()
  if (!db || !saved) return
  try {
    insertAll(db, 'local_accounts', saved.accounts)
    insertAll(db, 'local_sessions', saved.sessions)
  } finally {
    db.close()
  }
})

test('全新安装：打开任何页面都先到登录页（带进场动画），“LULUX”栏直接是创建本机账户，不能跳过', async ({ page }) => {
  await page.goto('/#/customers')
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByTestId('login-page')).toHaveClass(/ao-intro/)
  await expect(page.getByText('LULUX ETA', { exact: true })).toBeVisible()
  await expect(page.getByText('外贸客户与询盘工作台')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'LULUX', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: '云端 LULUX' })).toHaveAttribute('aria-selected', 'false')
  const form = page.getByTestId('local-create-form')
  await expect(form.getByLabel('用户名', { exact: true })).toBeEnabled()
  await expect(form.getByLabel('密码', { exact: true })).toBeEnabled()
  await expect(form.getByLabel('确认密码')).toBeVisible()
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('local-first-run')).toContainText('还没有本机账户')
  await expect(page.getByTestId('local-back')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0)
  // 动画放完后去掉 ao-intro，品牌标志完全显示
  await expect(page.getByTestId('login-page')).not.toHaveClass(/ao-intro/, { timeout: 5000 })
  await expect(page.locator('.ao-brand img')).toHaveCSS('opacity', '1')
  // 没建账户不能进业务页
  await page.goto('/#/')
  await expect(page).toHaveURL(/#\/login/)
})

test('本机账户：创建 → 设置里看到用户名 → 退出 → 必须登录 → 错误密码提示 → 登录成功', async ({ page }) => {
  await page.goto('/#/login')
  const form = page.getByTestId('local-create-form')
  await form.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await form.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  await form.getByLabel('确认密码').fill('mismatch-0000')
  await page.getByRole('button', { name: '创建并登录' }).click()
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致')
  await form.getByLabel('确认密码').fill(LOCAL.password)
  // 默认不勾“记住这台机器”；这里勾上
  await expect(form.locator('.ao-check input')).not.toBeChecked()
  await form.getByText('记住这台机器').click()
  await page.getByRole('button', { name: '创建并登录' }).click()
  // 先显示一次性恢复码：Esc 关不掉，点“我已保存”才进入
  const codeDialog = page.getByTestId('recovery-dialog')
  await expect(codeDialog).toContainText('它只显示这一次')
  recoveryCode = (await page.getByTestId('recovery-code').textContent())?.trim() ?? ''
  expect(recoveryCode).toMatch(CODE_RE)
  await page.keyboard.press('Escape')
  await expect(codeDialog).toBeVisible()
  await page.getByRole('button', { name: '我已保存' }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()

  await page.goto('/#/settings/account')
  await expect(page.getByTestId('local-username')).toHaveText(LOCAL.username)
  // 记住这台机器：刷新 / 新窗口后仍是登录状态
  await page.reload()
  await expect(page.getByTestId('local-username')).toHaveText(LOCAL.username)
  const again = await page.context().newPage()
  await again.goto('/#/')
  await expect(again.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await again.close()

  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByTestId('local-no-account')).toHaveCount(0)
  // 有账户后未登录不能进入业务页
  await page.goto('/#/customers')
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByRole('tab', { name: 'LULUX', exact: true })).toHaveAttribute('aria-selected', 'true')
  // 上次勾过“记住”：仍预先勾上，用户名预填
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue(LOCAL.username)

  await page.getByLabel('用户名', { exact: true }).fill('koko')
  await page.getByLabel('密码', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
  await expect(page).toHaveURL(/#\/login/)

  await page.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '客户', level: 1 })).toBeVisible()
})

test('不勾“记住这台机器”：会话只在这个窗口；重新打开（新窗口）又回到登录页并播放动画', async ({ page }) => {
  await page.goto('/#/login')
  await page.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await page.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  const box = page.locator('.ao-check input')
  if (await box.isChecked()) await page.getByText('记住这台机器').click()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  const reopened = await page.context().newPage()
  await reopened.goto('/#/')
  await expect(reopened).toHaveURL(/#\/login/)
  await expect(reopened.getByTestId('login-page')).toHaveClass(/ao-intro/)
  await expect(reopened.locator('.ao-check input')).not.toBeChecked()
  await reopened.close()
})

/**
 * 模拟桌面端（Electron）：window.luluxAgent.api 的本机会话 / 登录偏好接口接到这个“主进程”存储上。
 * 每次“启动”是一个全新的浏览器上下文 —— 与打包版一样，本地端口一变页面 origin 就变，localStorage / sessionStorage 都是空的；
 * 只有“主进程”里加密落盘的部分（disk）跨重启保留，内存（memory）随进程退出清空。
 */
function fakeMainProcess() {
  const store = {
    memory: null as { token: string; username: string } | null,
    disk: null as { token: string; username: string } | null,
    prefs: {} as unknown,
  }
  async function launch(browser: Browser, baseURL: string): Promise<BrowserContext> {
    store.memory = null
    const context = await browser.newContext({ baseURL, extraHTTPHeaders: {} })
    await context.exposeBinding('__luluxMain', (_source, op: string, a?: unknown, b?: { persist?: boolean }) => {
      if (op === 'getLocalSession') return store.memory ?? store.disk
      if (op === 'setLocalSession') {
        const session = a as { token: string; username: string } | null
        store.memory = session
        store.disk = session && b?.persist ? session : null
        return { persisted: Boolean(session && b?.persist) }
      }
      if (op === 'getLoginPrefs') return store.prefs
      if (op === 'setLoginPrefs') {
        store.prefs = a
        return a
      }
      return null
    })
    await context.addInitScript(() => {
      const main = (window as unknown as { __luluxMain: (...args: unknown[]) => Promise<unknown> }).__luluxMain
      ;(window as unknown as { luluxAgent: unknown }).luluxAgent = {
        apiToken: '',
        platform: 'linux',
        versions: { electron: '0', chrome: '0', node: '0' },
        api: {
          mode: 'local',
          baseUrl: '',
          getSession: async () => ({ mode: 'local', baseUrl: '', token: null, user: null }),
          setSession: async () => undefined,
          getConnection: async () => ({ mode: 'local', serverUrl: null, recentServers: [] }),
          connectRemote: async () => ({ ok: false, error: 'not in e2e' }),
          useLocal: async () => undefined,
          getLocalSession: () => main('getLocalSession'),
          setLocalSession: (s: unknown, o: unknown) => main('setLocalSession', s, o),
          getLoginPrefs: () => main('getLoginPrefs'),
          setLoginPrefs: (p: unknown) => main('setLoginPrefs', p),
        },
      }
    })
    return context
  }
  return { store, launch }
}

test('桌面端“记住这台机器”：退出再打开（页面存储全新）直接进入；登出后回到登录页，用户名预填、仍勾选、光标在密码框', async ({
  browser,
  baseURL,
}) => {
  const main = fakeMainProcess()
  let context = await main.launch(browser, baseURL!)
  let page = await context.newPage()
  await page.goto('/#/login')
  await page.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await page.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  const box = page.locator('.ao-check input')
  if (!(await box.isChecked())) await page.getByText('记住这台机器').click()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await expect.poll(() => main.store.disk?.username).toBe(LOCAL.username)
  // 会话不再放在页面的 localStorage（换端口就丢）
  expect(await page.evaluate(() => localStorage.getItem('lulux.localSession'))).toBeNull()
  await context.close()

  // 重启：全新的页面存储，主进程记住的会话还在 → 直接进入，不经过登录页
  context = await main.launch(browser, baseURL!)
  page = await context.newPage()
  await page.goto('/#/settings/account')
  await expect(page.getByTestId('local-username')).toHaveText(LOCAL.username)
  await expect(page).not.toHaveURL(/#\/login/)

  // 主动登出：清掉记住的会话；重启后回到登录页，用户名预填、仍勾选、光标在密码框
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/#\/login/)
  await expect.poll(() => main.store.disk).toBeNull()
  await context.close()
  context = await main.launch(browser, baseURL!)
  page = await context.newPage()
  await page.goto('/#/')
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue(LOCAL.username)
  await expect(page.locator('.ao-check input')).toBeChecked()
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused()

  // 这次不勾：重启后不保留会话，也不再预填
  await page.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  await page.getByText('记住这台机器').click()
  await expect(page.locator('.ao-check input')).not.toBeChecked()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await expect.poll(() => main.store.disk).toBeNull()
  // 同一次运行内重载窗口：会话还在（主进程内存）
  await page.reload()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await context.close()
  context = await main.launch(browser, baseURL!)
  page = await context.newPage()
  await page.goto('/#/')
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('')
  await expect(page.locator('.ao-check input')).not.toBeChecked()
  await context.close()
})

test('本机账户：新的浏览器窗口（没有会话）先到登录页；设置 → 账户 可以修改密码', async ({ page }) => {
  await page.goto('/#/')
  await expect(page).toHaveURL(/#\/login/)
  await page.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await page.getByLabel('密码', { exact: true }).fill(LOCAL.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()

  await page.goto('/#/settings/account')
  await page.getByTestId('local-change-password').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('当前密码').fill('not-the-password')
  await dialog.getByLabel('新密码（8–128 位）').fill('brand new pass 1')
  await dialog.getByLabel('再次输入新密码').fill('brand new pass 1')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('当前密码不正确')
  await dialog.getByLabel('当前密码').fill(LOCAL.password)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('忘记密码：恢复码重设并登录，显示新恢复码；恢复码也丢了 → 数据目录放 RESET-LOCAL-PASSWORD 文件后重设，文件被删除', async ({
  page,
}) => {
  await page.goto('/#/login')
  await page.getByTestId('local-forgot').click()
  const form = page.getByTestId('local-forgot-form')
  await form.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await form.getByLabel('恢复码').fill('AAAAA-AAAAA-AAAAA-AAAAA')
  await form.getByLabel('新密码', { exact: true }).fill('recovered pass 1')
  await form.getByLabel('确认密码').fill('recovered pass 1')
  await page.getByRole('button', { name: '重设密码并登录' }).click()
  await expect(page.getByRole('alert')).toHaveText('用户名或恢复码不正确')
  await form.getByLabel('恢复码').fill(recoveryCode.toLowerCase())
  await page.getByRole('button', { name: '重设密码并登录' }).click()
  await expect(page.getByTestId('recovery-dialog')).toContainText('旧的恢复码已作废')
  const next = (await page.getByTestId('recovery-code').textContent())?.trim() ?? ''
  expect(next).toMatch(CODE_RE)
  expect(next).not.toBe(recoveryCode)
  await page.getByRole('button', { name: '我已保存' }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()

  // 恢复码也丢了：说明里给出数据目录
  const reopened = await page.context().newPage()
  await reopened.goto('/#/login')
  await reopened.getByTestId('local-forgot').click()
  await reopened.getByTestId('local-lost-code').click()
  await expect(reopened.getByTestId('local-lost-code-help')).toContainText(
    '在此目录新建名为 RESET-LOCAL-PASSWORD 的空文件，然后重启 LULUX',
  )
  const dataDir = process.env.E2E_DATA_DIR
  if (!dataDir) {
    await reopened.close()
    return
  }
  await expect(reopened.getByTestId('local-data-dir')).toHaveText(dataDir)
  const resetFile = join(dataDir, 'RESET-LOCAL-PASSWORD')
  writeFileSync(resetFile, '')
  await reopened.getByTestId('local-recheck').click()
  await expect(reopened.getByTestId('local-reset-file-found')).toBeVisible()
  const fileForm = reopened.getByTestId('local-forgot-form')
  await expect(fileForm.getByLabel('恢复码')).toHaveCount(0)
  await fileForm.getByLabel('用户名', { exact: true }).fill(LOCAL.username)
  await fileForm.getByLabel('新密码', { exact: true }).fill(LOCAL.password)
  await fileForm.getByLabel('确认密码').fill(LOCAL.password)
  await reopened.getByRole('button', { name: '重设密码并登录' }).click()
  await expect(reopened.getByTestId('recovery-dialog')).toBeVisible()
  expect(existsSync(resetFile)).toBe(false)
  await reopened.getByRole('button', { name: '我已保存' }).click()
  await expect(reopened.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await reopened.close()
  // 重设后旧会话失效
  await page.reload()
  await expect(page).toHaveURL(/#\/login/)
})

test('云端 LULUX 栏：服务器地址 + 邮箱 + 密码，内联校验，http 非本机地址被拒，不会切换连接', async ({ page }) => {
  await page.goto('/#/login')
  await page.getByRole('tab', { name: '云端 LULUX' }).click()
  await expect(page.getByText('记住这台服务器')).toBeVisible()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(['请输入服务器地址', '请输入邮箱', '请输入密码'])
  await page.getByLabel('服务器地址').fill('http://eta.example.com')
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com')
  await page.getByLabel('密码', { exact: true }).fill('whatever-1')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(/https/)
  await expect(page.getByLabel('服务器地址')).toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByRole('alert')).toHaveText(/https/)
  expect(await page.evaluate(() => localStorage.getItem('lulux.server'))).toBeNull()
  await expect(page).toHaveURL(/#\/login/)
})
