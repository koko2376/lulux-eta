import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DISPLAY_VERSIONS, displayVersion, isPrereleaseVersion } from '../src/version'

// 与 electron-updater 同一个比较库（它用 semver.gt / semver.eq 判断有没有新版本）
const semver = createRequire(__filename)('semver') as typeof import('semver')
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string; displayVersion?: string }

describe('版本号：四段式修复版与自动更新', () => {
  it('package.json 的版本是合法 semver，显示版本与登记表一致', () => {
    expect(semver.valid(pkg.version)).toBe(pkg.version)
    expect(displayVersion(pkg.version)).toBe(pkg.displayVersion ?? pkg.version)
  })

  it('0.1.4 的客户端把修复版当成新版本；修复版自己不会反复提示；以后的正式版都更新', () => {
    for (const [semverVersion, shown] of Object.entries(DISPLAY_VERSIONS)) {
      expect(shown).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      const [major, minor, patch] = shown.split('.').map(Number)
      const base = `${major}.${minor}.${patch}`
      expect(semver.gt(semverVersion, base)).toBe(true)
      expect(semver.eq(semverVersion, semverVersion)).toBe(true)
      expect(semver.gt(`${major}.${minor}.${patch! + 1}`, semverVersion)).toBe(true)
      expect(semver.gt(`${major}.${minor + 1}.0`, semverVersion)).toBe(true)
    }
    expect(semver.gt(pkg.version, '0.1.4')).toBe(true)
    expect(semver.gt('0.1.5', pkg.version)).toBe(true)
  })

  it('修复版走正式通道，alpha / beta / rc 才算预发布', () => {
    expect(isPrereleaseVersion('0.1.5-0')).toBe(false)
    expect(isPrereleaseVersion('0.1.2-beta.1')).toBe(true)
    expect(isPrereleaseVersion('0.1.4')).toBe(false)
    expect(displayVersion('0.1.4')).toBe('0.1.4')
  })
})
