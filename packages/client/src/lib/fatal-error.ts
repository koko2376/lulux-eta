import { reactive } from 'vue'

/**
 * 全局错误兜底：页面渲染 / 初始化失败、更新后旧页面加载不到新的代码块时，
 * 显示一个友好的错误页和“重新加载”，而不是留下空白或半截界面。
 * 事件处理里的普通错误仍只弹 toast（见 main.ts 的 errorHandler）。
 */
export const fatalState = reactive<{ error: { message: string; detail: string } | null }>({ error: null })

export function reportFatal(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error))
  fatalState.error = {
    message: err.message || String(error),
    detail: (err.stack ?? '').split('\n').slice(0, 6).join('\n'),
  }
}

export function clearFatal(): void {
  fatalState.error = null
}

/**
 * Vue 的错误来源是否会让当前页面无法使用：setup / render 失败、挂载前后钩子失败。
 * 开发构建里 info 是文字（"render function"），生产构建里是错误码链接（…#runtime-1、…#runtime-m）。
 */
export function isFatalVueError(info: string): boolean {
  if (/setup function|render function|beforeMount hook|mounted hook|component update/i.test(info)) return true
  const code = /#runtime-([a-z0-9]+)$/i.exec(info)?.[1]
  return code === '0' || code === '1' || code === 'bm' || code === 'm' || code === '12'
}

/** 版本更新后旧页面去拉已经不存在的懒加载代码块 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \S+ failed|ChunkLoadError/i.test(
    message,
  )
}

export function reloadApp(): void {
  clearFatal()
  window.location.reload()
}
