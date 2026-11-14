import { computed } from 'vue'
import { auth } from './session'

/**
 * 本机存储（localStorage）的作用域：账号 + 服务器。
 *
 * 同一台电脑上换团队服务器、换登录账号后，上一次的“最近客户”“会话已读”“输入框草稿”
 * 都不该被当成这个账号的数据：每个作用域一份 key（`<前缀>:<hash>`），切回去还能拿回自己那份。
 * 作用域至少包含 mode + baseUrl + userId。本机模式不把端口写进去：
 * 桌面端重启后本地服务端口会变，写进去等于每次都换作用域、草稿全丢。
 */
export interface StorageScope {
  /** local = 桌面本机服务；remote = 手动连接 / 桌面远程模式的团队服务器；server = 同源部署的团队服务器 */
  mode: 'local' | 'remote' | 'server'
  /** 团队服务器地址；本机模式为空串（端口会变，不参与作用域） */
  baseUrl: string
  /** 登录用户 id；还没登录时为空串 */
  userId: string
}

export function currentScope(): StorageScope {
  const remote = auth.connection === 'remote'
  const sameOrigin = !remote && auth.mode === 'server'
  return {
    mode: remote ? 'remote' : sameOrigin ? 'server' : 'local',
    baseUrl: remote ? auth.serverUrl : sameOrigin && typeof location !== 'undefined' ? location.origin : '',
    userId: auth.me?.user?.id ?? '',
  }
}

/** 作用域指纹（FNV-1a 32 位）：同一账号同一服务器稳定，换一个就换 key；不把服务器地址 / 用户 id 明文写进 key */
export function scopeHash(scope: StorageScope): string {
  const raw = `${scope.mode}|${scope.baseUrl}|${scope.userId}`
  let hash = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function scopedKey(base: string, hash = scopeHash(currentScope())): string {
  return `${base}:${hash}`
}

/** 当前作用域指纹（响应式）：auth 里换了账号 / 服务器就会变 */
export const storageScopeHash = computed(() => scopeHash(currentScope()))

/** 本机模式的作用域：旧的无作用域 key 只迁到这里（桌面单用户的老数据） */
export function isLocalScope(): boolean {
  return currentScope().mode === 'local'
}
