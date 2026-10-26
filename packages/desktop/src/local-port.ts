/**
 * 本地服务端口的选择规则（页面 origin = http://127.0.0.1:<端口>，端口稳定，界面偏好才不会丢）：
 *
 * - 首次启动用固定的 DEFAULT_LOCAL_PORT。它在 1024–32767 之间，落在各系统的动态 / 临时端口段之外
 *   （Windows、macOS 的动态段是 49152–65535，Linux 默认 32768–60999）：
 *   Windows 开启虚拟化相关功能后，系统每次开机会在动态段里随机保留若干区间，落在其中的端口会监听失败。
 * - 之后沿用上次成功的端口。
 * - Windows 上旧版本记下的端口如果在动态段里，迁到新的固定端口一次（界面偏好由 ui-storage 随迁）。
 * - 端口被占用时由 server.ts 的 pickPort 依次试后面几个固定端口，最后才交给系统分配。
 */

export const DEFAULT_LOCAL_PORT = 31789

/** Windows 的动态端口段（默认 49152–65535） */
export const WINDOWS_DYNAMIC_START = 49152

export function isWindowsDynamicPort(port: number): boolean {
  return port >= WINDOWS_DYNAMIC_START && port <= 65535
}

/** 启动时优先尝试的端口 */
export function initialLocalPort(stored: number | null, platform: NodeJS.Platform): number {
  if (stored === null) return DEFAULT_LOCAL_PORT
  if (platform === 'win32' && isWindowsDynamicPort(stored)) return DEFAULT_LOCAL_PORT
  return stored
}
