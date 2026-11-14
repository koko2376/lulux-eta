import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WhatsAppAccountInfo } from '../src/services/whatsapp/types.js'

/**
 * 状态机四态、配对码格式与凭据权限的单元测试。
 * 不联网、不启动真实引擎；凭据写到临时目录，随时可删。
 */
const HOME = mkdtempSync(join(tmpdir(), 'lulux-whatsapp-unit-'))
const ACCOUNT: WhatsAppAccountInfo = {
  phone: '+8613800138000',
  deviceName: 'LULUX ETA 测试设备',
  platform: 'Chrome',
  linkedAt: 1_700_000_000_000,
  lastLoginAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_000_000,
}

let WhatsAppStateMachine: typeof import('../src/services/whatsapp/state-machine.js').WhatsAppStateMachine
let normalizeWhatsAppPhone: typeof import('../src/services/whatsapp/service.js').normalizeWhatsAppPhone
let store: typeof import('../src/services/whatsapp/credential-store.js')

beforeAll(async () => {
  process.env.LULUX_WHATSAPP_DIR = join(HOME, 'whatsapp')
  const stateModule = await import('../src/services/whatsapp/state-machine.js')
  const serviceModule = await import('../src/services/whatsapp/service.js')
  store = await import('../src/services/whatsapp/credential-store.js')
  WhatsAppStateMachine = stateModule.WhatsAppStateMachine
  normalizeWhatsAppPhone = serviceModule.normalizeWhatsAppPhone
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

const risk = { accepted: true, acceptedAt: 1, expiresAt: 2, version: '0.1.2' }

describe('WhatsApp 四态状态机', () => {
  it('未绑定 → 等扫码（connecting）→ 已连接 → 断开', () => {
    const machine = new WhatsAppStateMachine()
    expect(machine.snapshot(1000, risk)).toMatchObject({ phase: 'unbound', connection: 'disconnected' })

    machine.begin('qr', null, 1000)
    expect(machine.snapshot(1000, risk).connection).toBe('connecting')

    machine.qrReceived('data:image/png;base64,AAAA', 2000)
    expect(machine.snapshot(2000, risk)).toMatchObject({ phase: 'waiting_qr', connection: 'connecting' })
    expect(machine.snapshot(2000, risk).qr?.dataUrl).toContain('data:image/png')

    machine.connected(ACCOUNT, 3000)
    expect(machine.snapshot(3000, risk)).toMatchObject({ phase: 'connected', connection: 'connected' })
    expect(machine.snapshot(3000, risk).account?.phone).toBe('+8613800138000')

    machine.reset(4000)
    expect(machine.snapshot(4000, risk)).toMatchObject({ phase: 'unbound', connection: 'disconnected' })
  })

  it('失败 / 重连归入 disconnected / connecting', () => {
    const machine = new WhatsAppStateMachine()
    machine.begin('qr', null, 1000)
    machine.failed('ENGINE_LOAD_FAILED', '引擎加载失败', 1100)
    expect(machine.snapshot(1100, risk).connection).toBe('disconnected')

    machine.reconnecting({ attempt: 2, maxAttempts: 5, nextAt: 1500 }, 1200)
    expect(machine.snapshot(1200, risk)).toMatchObject({
      phase: 'reconnecting',
      connection: 'connecting',
      reconnect: { attempt: 2, maxAttempts: 5, nextAt: 1500 },
    })
  })

  it('手机端登出 → reauth；四态点与引用同一枚举', () => {
    const machine = new WhatsAppStateMachine()
    machine.connected(ACCOUNT, 1000)
    machine.loggedOut('AUTH_LOGGED_OUT', '已在手机上退出这台设备', 2000)
    expect(machine.snapshot(2000, risk)).toMatchObject({
      phase: 'reauth',
      connection: 'reauth',
      error: { code: 'AUTH_LOGGED_OUT' },
    })
  })

  it('二维码 20 秒过期只标记，不把面板打回未绑定', () => {
    const machine = new WhatsAppStateMachine()
    machine.begin('qr', null, 1000)
    machine.qrReceived('data:image/png;base64,AAAA', 1000)
    const expired = machine.snapshot(1000 + 20_000, risk)
    expect(expired.phase).toBe('waiting_qr')
    expect(expired.qr?.expired).toBe(true)
    expect(expired.connection).toBe('connecting')
  })

  it('配对码 4 分钟过期进入 failed，并明确提示重新生成', () => {
    const machine = new WhatsAppStateMachine()
    machine.begin('pairing', '8613800138000', 1000)
    machine.pairingReceived('4K7QM2X9', '8613800138000', 1000)
    const expired = machine.snapshot(1000 + 240_000, risk)
    expect(expired.phase).toBe('failed')
    expect(expired.connection).toBe('disconnected')
    expect(expired.error?.code).toBe('PAIRING_CODE_EXPIRED')
  })
})

describe('手机号校验', () => {
  it('接受带国家码的 E.164，返回去掉 + 的号码', () => {
    expect(normalizeWhatsAppPhone('+8613800138000')).toBe('8613800138000')
    expect(normalizeWhatsAppPhone(' +86 138-0013-8000 ')).toBe('8613800138000')
  })

  it.each([
    ['空值', ''],
    ['缺少国家码', '13800138000'],
    ['国家码为 0', '+013800138000'],
    ['太短', '+8613800'],
    ['太长', '+861380013800012345'],
    ['含字母', '+861380013800a'],
  ])('拒绝%s并给出 PAIRING_INVALID_PHONE', (_label, value) => {
    expect(() => normalizeWhatsAppPhone(value)).toThrowError(
      expect.objectContaining({ code: 'PAIRING_INVALID_PHONE', status: 400 }),
    )
  })
})

describe('凭据落盘', () => {
  it('保存 / 读取 account.json，目录 0700、文件 0600', () => {
    store.saveAccount('default', 'local', ACCOUNT)
    const file = store.accountFile('default')
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
    expect((statSync(store.accountDir('default')).mode & 0o777).toString(8)).toBe('700')
    const stored = store.readAccount('default')
    expect(stored).toMatchObject({
      version: 1,
      accountId: 'default',
      ownerId: 'local',
      credentialsValid: true,
      account: { phone: '+8613800138000' },
    })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('pairing')
  })

  it('chmodSession 把引擎自己写的文件收紧到 0600', () => {
    const dir = store.credentialsDir('default')
    const file = join(dir, 'creds.json')
    writeFileSync(file, '{"registered":false}')
    chmodSync(file, 0o644)
    store.chmodSession('default')
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700')
  })

  it('解绑删除整个会话目录', () => {
    store.saveAccount('default', 'local', ACCOUNT)
    expect(store.hasCredentials('default')).toBe(true)
    store.clearSession('default')
    expect(store.hasCredentials('default')).toBe(false)
    expect(store.readAccount('default')).toBeNull()
  })

  it('风险确认 30 天后失效', () => {
    store.acceptRisk('local', '0.1.2', 1_000)
    expect(store.readRisk('local', 1_001).accepted).toBe(true)
    expect(store.readRisk('local', 1_000 + 30 * 86_400_000 + 1).accepted).toBe(false)
  })
})
