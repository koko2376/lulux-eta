import { fetchDownload, sessionFileUrl } from '../api/skills'

/**
 * 会话工作区图片 → blob: URL（接口需要鉴权头，<img src> 不能直接指向 API）。
 * 按“会话 + 路径”缓存，同一张图只下载一次；切换会话不清理（图片很小，刷新页面即释放）。
 */
const cache = new Map<string, Promise<string>>()

export function sessionImageUrl(sessionId: string, path: string): Promise<string> {
  const key = `${sessionId}\n${path}`
  let hit = cache.get(key)
  if (!hit) {
    hit = fetchDownload(sessionFileUrl(sessionId, path)).then((blob) => URL.createObjectURL(blob))
    hit.catch(() => cache.delete(key))
    cache.set(key, hit)
  }
  return hit
}

/** 本地刚上传的图片：直接登记已有的 blob/data URL，发送后消息里的缩略图不用再下载 */
export function rememberSessionImage(sessionId: string, path: string, url: string): void {
  cache.set(`${sessionId}\n${path}`, Promise.resolve(url))
}

export function clearSessionImageCacheForTests(): void {
  cache.clear()
}
