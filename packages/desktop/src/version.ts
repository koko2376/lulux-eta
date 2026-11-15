/**
 * 版本号：自动更新用的 semver 与界面显示的版本号。
 *
 * electron-updater 只认 semver，并用 latest*.yml 里的 version 与已安装版本比大小。
 * 四段式的修复版（v0.1.4.1）没法写成 semver，所以 package.json 里写一个排在 0.1.4 之后、
 * 0.1.5 之前的 semver（0.1.5-0），界面、诊断信息与下载页链接显示成 0.1.4.1。
 * 以后的正式版本（0.1.5、0.2.0 …）都比它新，不需要在这里登记。
 */
export const DISPLAY_VERSIONS: Readonly<Record<string, string>> = {
  '0.1.5-0': '0.1.4.1',
}

/** semver → 对外显示的版本号（没有登记的原样返回） */
export function displayVersion(version: string): string {
  return DISPLAY_VERSIONS[version] ?? version
}

/** 只有 alpha / beta / rc 这类预发布版本才算 beta 通道；登记过的修复版是正式版 */
export function isPrereleaseVersion(version: string): boolean {
  if (version in DISPLAY_VERSIONS) return false
  return /-/.test(version)
}
