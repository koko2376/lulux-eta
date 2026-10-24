import { nextTick, reactive } from 'vue'

/**
 * 表单字段级错误：替代浏览器原生 required 气泡（样式不可控、不跟随语言）。
 * 字段输入框带 data-field="<key>"，set() 时自动聚焦第一个出错的字段。
 */
export function useFieldErrors<K extends string>(formId: string) {
  const errors = reactive({}) as Partial<Record<K, string>>
  let focusQueued = false

  function set(key: K, message: string): void {
    errors[key] = message
    if (focusQueued) return
    focusQueued = true
    void nextTick(() => {
      focusQueued = false
      const el = document.querySelector<HTMLElement>(`#${formId} [data-field="${key}"]`)
      el?.focus()
    })
  }

  function clear(key?: K): void {
    if (key) delete errors[key]
    else for (const k of Object.keys(errors) as K[]) delete errors[k]
  }

  /** 校验一组必填字段（值为空白即出错），返回是否全部通过 */
  function require(fields: Partial<Record<K, unknown>>, message: (key: K) => string): boolean {
    let ok = true
    for (const [key, value] of Object.entries(fields) as [K, unknown][]) {
      if (value === undefined || value === null || String(value).trim() === '') {
        set(key, message(key))
        ok = false
      }
    }
    return ok
  }

  return { errors, set, clear, require }
}
