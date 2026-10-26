import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  applyPrefsPatch,
  defaultPrefs,
  HIDDEN_ARG,
  linuxAutostartEntry,
  linuxAutostartFile,
  readPrefs,
  setLinuxAutostart,
  writePrefs,
} from '../src/desktop-prefs'
import { buildDiagnosticsZip, diagnosticsFileName, redactLine } from '../src/diagnostics'
import { RestartPolicy } from '../src/supervisor'
import { classifyUpdateError, normalizeFeedUrl } from '../src/update-source'

/** 读回 writeZip 的产物（只支持本模块写出的格式） */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let offset = 0
  while (buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8)
    const size = buf.readUInt32LE(offset + 18)
    const nameLength = buf.readUInt16LE(offset + 26)
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const body = buf.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size)
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'))
    offset += 30 + nameLength + size
  }
  return out
}

describe('桌面偏好', () => {
  it('默认值按平台：Windows 关窗到托盘；Linux 默认关（托盘宿主不一定有）；macOS 按系统习惯', () => {
    expect(defaultPrefs('win32').closeToTray).toBe(true)
    expect(defaultPrefs('linux').closeToTray).toBe(false)
    expect(defaultPrefs('darwin').closeToTray).toBe(false)
    expect(defaultPrefs('win32').launchAtLogin).toBe(false)
  })

  it('读写与容错；补丁只接受两项布尔值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lulux-prefs-'))
    const file = join(dir, 'desktop-prefs.json')
    expect(readPrefs(file, 'win32')).toEqual(defaultPrefs('win32'))
    writeFileSync(file, '{broken')
    expect(readPrefs(file, 'linux')).toEqual(defaultPrefs('linux'))
    const next = applyPrefsPatch(defaultPrefs('win32'), { closeToTray: false, launchAtLogin: true })
    writePrefs(file, next)
    expect(readPrefs(file, 'win32')).toMatchObject({ closeToTray: false, launchAtLogin: true })
    expect(() => applyPrefsPatch(next, { closeToTray: 'yes' })).toThrow(/布尔/)
    expect(() => applyPrefsPatch(next, { trayHintShown: true })).toThrow(/未知/)
    expect(() => applyPrefsPatch(next, null)).toThrow()
  })

  it('Linux 开机自启动写 XDG autostart 条目（带隐藏启动参数），关闭时删除', () => {
    const entry = linuxAutostartEntry('/opt/LULUX ETA/lulux-eta')
    expect(entry).toContain('[Desktop Entry]')
    expect(entry).toContain(`Exec="/opt/LULUX ETA/lulux-eta" ${HIDDEN_ARG}`)
    const home = mkdtempSync(join(tmpdir(), 'lulux-xdg-'))
    setLinuxAutostart(home, '/tmp/LULUX.AppImage', true)
    expect(readFileSync(linuxAutostartFile(home), 'utf8')).toContain(`Exec=/tmp/LULUX.AppImage ${HIDDEN_ARG}`)
    setLinuxAutostart(home, '/tmp/LULUX.AppImage', false)
    expect(existsSync(linuxAutostartFile(home))).toBe(false)
  })
})

describe('本地服务自动重启节奏', () => {
  it('退避 1s → 3s → 10s → 30s，窗口内超过上限放弃', () => {
    const policy = new RestartPolicy({ maxRestarts: 5, windowMs: 600_000, stableMs: 300_000 })
    policy.started(0)
    const delays = [1, 2, 3, 4, 5].map((i) => policy.nextDelay(i * 1000))
    expect(delays).toEqual([1000, 3000, 10_000, 30_000, 30_000])
    expect(policy.nextDelay(6000)).toBeNull()
  })

  it('稳定运行一段时间后重新从最短间隔开始', () => {
    const policy = new RestartPolicy({ stableMs: 60_000 })
    policy.started(0)
    expect(policy.nextDelay(1000)).toBe(1000)
    policy.started(2000)
    expect(policy.nextDelay(3000)).toBe(3000)
    policy.started(4000)
    expect(policy.nextDelay(4000 + 61_000)).toBe(1000)
    expect(policy.attempts).toBe(1)
  })
})

describe('诊断包', () => {
  it('逐行脱敏：令牌、密钥、URL 里的密码、JSON 敏感字段', () => {
    expect(redactLine('Authorization: Bearer abcdefghijklmnopqrstu')).toBe('Authorization: Bearer [REDACTED]')
    expect(redactLine('key sk-abcdef0123456789zz')).toContain('sk-abcdef…[REDACTED]')
    expect(redactLine('proxy http://bob:hunter2@proxy.local:8080')).toBe('proxy http://[REDACTED]@proxy.local:8080')
    expect(redactLine('{"apiKey":"abc123","name":"ok"}')).toBe('{"apiKey":"[REDACTED]","name":"ok"}')
    expect(redactLine(`token ${'a1'.repeat(32)}`)).toBe('token [REDACTED-HEX]')
    expect(redactLine('--lulux-api-token=deadbeef')).toBe('--lulux-api-token=[REDACTED]')
    expect(redactLine('session lxs_' + 'f'.repeat(64))).toBe('session lxs_[REDACTED]')
  })

  it('打包最近的日志 + info.json，旧日志不带', () => {
    const root = mkdtempSync(join(tmpdir(), 'lulux-diag-'))
    const server = join(root, 'server')
    const desktop = join(root, 'desktop')
    mkdirSync(server)
    mkdirSync(desktop)
    writeFileSync(join(server, 'lulux-2026-10-20.log'), '{"msg":"hello","password":"p@ss"}\nBearer zzzzzzzzzzzzzzzz\n')
    writeFileSync(join(server, 'lulux-2026-09-01.log'), 'old\n')
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(join(server, 'lulux-2026-09-01.log'), old, old)
    writeFileSync(join(desktop, 'desktop.log'), 'restart ok\n')
    writeFileSync(join(server, 'master.key'), 'should-not-be-read')
    const prefs = join(root, 'updater.json')
    writeFileSync(prefs, JSON.stringify({ feedUrl: 'https://u:secret@mirror.example.com/x/' }))

    const { zip, files } = buildDiagnosticsZip({
      sources: [
        { label: 'server', dir: server },
        { label: 'desktop', dir: desktop },
        { label: 'missing', dir: join(root, 'nope') },
      ],
      days: 3,
      info: { app: 'LULUX ETA', version: '0.1.1' },
      extraFiles: [{ path: 'settings/updater.json', file: prefs }],
    })
    expect(files).toEqual(['logs/server/lulux-2026-10-20.log', 'logs/desktop/desktop.log', 'settings/updater.json'])
    const entries = unzip(zip)
    expect([...entries.keys()][0]).toBe('info.json')
    expect(JSON.parse(entries.get('info.json')!)).toMatchObject({ app: 'LULUX ETA', version: '0.1.1', logDays: 3 })
    const log = entries.get('logs/server/lulux-2026-10-20.log')!
    expect(log).toContain('"password":"[REDACTED]"')
    expect(log).toContain('Bearer [REDACTED]')
    expect(log).not.toContain('p@ss')
    expect(entries.get('settings/updater.json')).not.toContain('secret')
    expect([...entries.keys()].some((name) => name.includes('master.key'))).toBe(false)
  })

  it('文件名带日期时间', () => {
    expect(diagnosticsFileName(new Date(2026, 9, 21, 9, 5))).toBe('lulux-diagnostics-20261021-0905.zip')
  })
})

describe('更新源地址与错误归类', () => {
  it('规范化：只收 https（http 仅限本机回环）、补末尾斜杠、空值表示默认源', () => {
    expect(normalizeFeedUrl('https://mirror.example.com/lulux')).toBe('https://mirror.example.com/lulux/')
    expect(normalizeFeedUrl('  https://10.0.0.5:8443/updates/  ')).toBe('https://10.0.0.5:8443/updates/')
    expect(() => normalizeFeedUrl('http://10.0.0.5:8080/updates/')).toThrow(/https/)
    expect(normalizeFeedUrl('')).toBeNull()
    expect(normalizeFeedUrl(null)).toBeNull()
    expect(() => normalizeFeedUrl('ftp://x.example.com/')).toThrow(/http/)
    expect(() => normalizeFeedUrl('not a url')).toThrow(/有效/)
    expect(() => normalizeFeedUrl('https://a:b@x.example.com/')).toThrow(/用户名/)
  })

  it('网络 / 404 / 权限 / 格式错误分别归类', () => {
    const net = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
    expect(classifyUpdateError(net)).toBe('network')
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe('network')
    expect(classifyUpdateError(new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404'))).toBe('not-found')
    expect(classifyUpdateError(new Error('HttpError: 403 Forbidden'))).toBe('forbidden')
    expect(classifyUpdateError(new Error('Cannot parse update info: YAMLException'))).toBe('bad-feed')
    expect(classifyUpdateError('weird')).toBe('other')
  })
})
