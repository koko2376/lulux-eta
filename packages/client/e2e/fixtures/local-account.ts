/**
 * e2e 用的本机账户。桌面端现在总是先到登录页（没有账户先创建），业务用例不想每个都走一遍登录：
 * globalSetup 在 desktop 服务上建好这个账户，把会话 token 放进 E2E_LOCAL_SESSION，
 * playwright.config 用 extraHTTPHeaders 给每个请求带上 X-Lulux-Session（页面请求和 page.request 都带）。
 * 登录页本身（创建 / 登录 / 退出 / 记住）由 login.spec.ts 在一个没有这个头的干净上下文里验收。
 */
export const E2E_LOCAL = { username: 'e2e-owner', password: 'e2e owner pass 2026' }
export const LOCAL_SESSION_ENV = 'E2E_LOCAL_SESSION'

/**
 * 登录页首次打开（本标签页内）先显示开屏欢迎页，点「登录 →」才出表单。
 * 业务用例走到登录页时调用：有欢迎页就点过去，已经是表单就什么都不做。
 */
export async function passWelcome(page: import('@playwright/test').Page): Promise<void> {
  const start = page.getByTestId('login-welcome-start')
  await page.locator('[data-testid="login-welcome-start"], [role="tab"]').first().waitFor()
  if (await start.isVisible()) {
    await start.click()
    await page.getByTestId('login-welcome').waitFor({ state: 'detached' })
  }
}
