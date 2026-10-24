/**
 * 登录页开屏欢迎页：每个窗口只在第一次看到登录页时出现一次。
 * 已经进过业务页（记住登录 / 刚登录过）的窗口再回到登录页（退出、切换账户）直接是表单。
 */
export const WELCOME_KEY = 'lulux.welcomed'

export function markWelcomed(): void {
  try {
    sessionStorage.setItem(WELCOME_KEY, '1')
  } catch {
    // 存储不可用：不影响使用，最多再看到一次欢迎页
  }
}

export function welcomedThisWindow(): boolean {
  try {
    return sessionStorage.getItem(WELCOME_KEY) === '1'
  } catch {
    return true
  }
}
