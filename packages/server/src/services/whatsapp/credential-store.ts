import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from '../../config.js'
import { WHATSAPP_RISK_TTL_MS, type WhatsAppAccountInfo } from './types.js'

/**
 * WhatsApp 本地凭据与风险确认的落盘层。
 *
 * - 目录：`<dataDir>/whatsapp/sessions/<accountId>/creds`，整台服务只用 `default` 一个账号。
 * - 权限：目录 700、文件 600；Baileys 自己写文件后由 chmodSession 统一收紧。
 * - 配对码、二维码原文不落盘、不写日志；这里只存账号展示信息与「凭据是否有效」。
 */

export const WHATSAPP_ROOT_ENV = 'LULUX_WHATSAPP_DIR'
export const DEFAULT_ACCOUNT_ID = 'default'

export function whatsappRoot(): string {
  return process.env[WHATSAPP_ROOT_ENV] || join(config.home, 'whatsapp')
}

export function engineRoot(): string {
  return join(whatsappRoot(), 'engine')
}

export function logsDir(): string {
  return join(whatsappRoot(), 'logs')
}

export function accountDir(accountId = DEFAULT_ACCOUNT_ID): string {
  return join(whatsappRoot(), 'sessions', accountId)
}

export function credentialsDir(accountId = DEFAULT_ACCOUNT_ID): string {
  return join(accountDir(accountId), 'creds')
}

export interface StoredAccount {
  version: 1
  accountId: string
  ownerId: string
  credentialsValid: boolean
  account: WhatsAppAccountInfo
  savedAt: number
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows 忽略
  }
}

/** 原子写 + 0600；先写同目录临时文件再 rename，避免进程中断留下半个 JSON */
export function writePrivateJson(file: string, value: unknown): void {
  ensurePrivateDir(dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // Windows 忽略
  }
  renameSync(temp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 忽略
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 把会话目录下所有文件收紧到 0600（Baileys 的 useMultiFileAuthState 自己写文件） */
export function chmodSession(accountId = DEFAULT_ACCOUNT_ID): void {
  chmodTree(accountDir(accountId))
}

/** 递归收紧目录（700）与文件（600） */
export function chmodTree(root: string): void {
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Windows 忽略
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        try {
          chmodSync(path, 0o600)
        } catch {
          // Windows 忽略
        }
      }
    }
  }
  walk(root)
}

export function accountFile(accountId = DEFAULT_ACCOUNT_ID): string {
  return join(accountDir(accountId), 'account.json')
}

export function saveAccount(
  accountId: string,
  ownerId: string,
  account: WhatsAppAccountInfo,
): void {
  ensurePrivateDir(credentialsDir(accountId))
  const stored: StoredAccount = {
    version: 1,
    accountId,
    ownerId,
    credentialsValid: true,
    account,
    savedAt: Date.now(),
  }
  writePrivateJson(accountFile(accountId), stored)
}

export function readAccount(accountId = DEFAULT_ACCOUNT_ID): StoredAccount | null {
  const stored = readJson<StoredAccount>(accountFile(accountId))
  if (!stored || stored.version !== 1 || !stored.account) return null
  return stored
}

export function hasCredentials(accountId = DEFAULT_ACCOUNT_ID): boolean {
  try {
    return statSync(credentialsDir(accountId)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 退出 / 401 被登出后凭据立即失效：删除整个会话目录（含 creds 与 account.json）。
 * 手机端已经作废旧凭据，本地继续保留只会让下一次连接反复失败。
 */
export function clearSession(accountId = DEFAULT_ACCOUNT_ID): void {
  rmSync(accountDir(accountId), { recursive: true, force: true })
}

/* ── 风险确认 ── */

export interface RiskRecord {
  userId: string
  acceptedAt: number
  version: string
}

interface RiskFile {
  version: 1
  records: Record<string, RiskRecord>
}

function riskFile(): string {
  return join(whatsappRoot(), 'risk-acceptance.json')
}

function readRiskFile(): RiskFile {
  const file = readJson<RiskFile>(riskFile())
  if (!file || file.version !== 1 || !file.records || typeof file.records !== 'object') {
    return { version: 1, records: {} }
  }
  return file
}

export interface RiskState {
  accepted: boolean
  acceptedAt: number | null
  expiresAt: number | null
  version: string | null
}

export function readRisk(userId: string, now = Date.now()): RiskState {
  const record = readRiskFile().records[userId]
  if (!record) return { accepted: false, acceptedAt: null, expiresAt: null, version: null }
  const expiresAt = record.acceptedAt + WHATSAPP_RISK_TTL_MS
  if (expiresAt <= now) {
    return { accepted: false, acceptedAt: record.acceptedAt, expiresAt, version: record.version }
  }
  return { accepted: true, acceptedAt: record.acceptedAt, expiresAt, version: record.version }
}

export function acceptRisk(userId: string, version: string, now = Date.now()): RiskState {
  const file = readRiskFile()
  file.records[userId] = { userId, acceptedAt: now, version }
  writePrivateJson(riskFile(), file)
  return { accepted: true, acceptedAt: now, expiresAt: now + WHATSAPP_RISK_TTL_MS, version }
}

/** 测试与登出兜底：只清风险记录，不动会话 */
export function clearRiskForTests(userId?: string): void {
  if (userId === undefined) {
    rmSync(riskFile(), { force: true })
    return
  }
  const file = readRiskFile()
  delete file.records[userId]
  writePrivateJson(riskFile(), file)
}

export function ensureWhatsAppDirs(): void {
  ensurePrivateDir(whatsappRoot())
  ensurePrivateDir(join(whatsappRoot(), 'sessions'))
  ensurePrivateDir(engineRoot())
  ensurePrivateDir(logsDir())
}

export function exists(path: string): boolean {
  return existsSync(path)
}
