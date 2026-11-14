import { config } from '@vue/test-utils'
import { i18n } from './i18n'

// 组件测试统一装上 i18n（默认简体中文），模板里的 $t 才可用
config.global.plugins = [...(config.global.plugins ?? []), i18n]

/**
 * Node 26 自带一个需要 --localstorage-file 的 localStorage 全局，vitest 的 jsdom 环境因此不再把
 * jsdom 的 Storage 挂上来：没带参数时 typeof localStorage === 'undefined'，用 localStorage 的测试
 * 全部报错。这里补一个内存实现（浏览器里本来就有，不受影响）——草稿、未读、最近客户都靠它。
 */
class MemoryStorage implements Storage {
  private items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value))
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  for (const scope of [globalThis, typeof window === 'undefined' ? undefined : window]) {
    if (!scope || typeof (scope as unknown as Record<string, unknown>)[name] !== 'undefined') continue
    Object.defineProperty(scope, name, { value: new MemoryStorage(), configurable: true, writable: true })
  }
}
