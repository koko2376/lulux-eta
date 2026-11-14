import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppError } from '../../errors.js'
import { BaileysAdapter } from './baileys-adapter.js'
import { engineRoot } from './credential-store.js'
import type { WhatsAppEngineFactory, WhatsAppEngineInfo } from './types.js'

/**
 * 运行时引擎加载（调研 §3.5）：
 * - 引擎**不进任何 package.json**，也不进桌面单文件 bundle；只从数据目录 / 仓库外置目录加载。
 * - 目录约定：`<dataDir>/whatsapp/engine/<baileys@x.y.z>/`，或 `LULUX_WHATSAPP_ENGINE_DIR` 明确指定，
 *   或仓库根 `.eta-engines/whatsapp/`（已加入 .gitignore）。
 * - 引擎或二维码渲染库缺失时必须返回明确错误码，不允许静默回退。
 */
export const ENGINE_MODE_ENV = 'LULUX_WHATSAPP_ENGINE'
export const ENGINE_DIR_ENV = 'LULUX_WHATSAPP_ENGINE_DIR'

const BAILEYS_PACKAGES = ['baileys', '@whiskeysockets/baileys']

export interface EngineCandidate {
  dir: string
  packageName: string
  version: string | null
  qrAvailable: boolean
}

function readPackageVersion(path: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function inspectDir(dir: string): EngineCandidate | null {
  for (const name of BAILEYS_PACKAGES) {
    const pkgFile = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(pkgFile)) continue
    return {
      dir,
      packageName: name,
      version: readPackageVersion(pkgFile),
      qrAvailable: existsSync(join(dir, 'node_modules', 'qrcode', 'package.json')),
    }
  }
  return null
}

function candidateDirs(): string[] {
  const explicit = process.env[ENGINE_DIR_ENV]?.trim()
  if (explicit) return [resolve(explicit)]

  const dirs: string[] = []
  const root = engineRoot()
  if (existsSync(root)) {
    dirs.push(root)
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(root, entry.name))
      }
    } catch {
      // 目录不可读时按未安装处理，错误会显示在 status 里
    }
  }
  // 仓库外置目录：兼容从仓库根或 packages/server 启动
  const cwd = process.cwd()
  for (const base of [cwd, resolve(cwd, '..'), resolve(cwd, '..', '..'), resolve(cwd, '..', '..', '..')]) {
    dirs.push(join(base, '.eta-engines', 'whatsapp'))
  }
  return [...new Set(dirs)]
}

export function findEngine(): EngineCandidate | null {
  for (const dir of candidateDirs()) {
    const found = inspectDir(dir)
    if (found) return found
  }
  return null
}

export function inspectEngine(): WhatsAppEngineInfo {
  const mode = (process.env[ENGINE_MODE_ENV] || 'baileys').trim().toLowerCase()
  if (mode === 'fake' || mode === 'mock') {
    return { id: 'fake', installed: true, version: '0.0.0-fake', dir: null, qrAvailable: true, error: null }
  }
  const explicit = process.env[ENGINE_DIR_ENV]?.trim()
  const found = findEngine()
  if (!found) {
    const searched = explicit ? resolve(explicit) : engineRoot()
    return {
      id: 'baileys',
      installed: false,
      version: null,
      dir: null,
      qrAvailable: false,
      error: {
        code: 'ENGINE_NOT_INSTALLED',
        message: `WhatsApp 引擎尚未安装：在 ${searched} 找不到 baileys。请按 docs/WHATSAPP-ENGINE.md 在本机安装运行时引擎后重试`,
      },
    }
  }
  return {
    id: 'baileys',
    installed: true,
    version: found.version,
    dir: found.dir,
    qrAvailable: found.qrAvailable,
    error: null,
  }
}

export interface BaileysModules {
  makeWASocket: (config: Record<string, unknown>) => any
  useMultiFileAuthState: (dir: string) => Promise<{ state: any; saveCreds: () => Promise<void> }>
  DisconnectReason: Record<string, number> | undefined
  fetchLatestBaileysVersion?: () => Promise<{ version: number[]; isLatest: boolean }>
  toDataUrl: (text: string, options?: Record<string, unknown>) => Promise<string>
}

/** 从引擎目录动态 import；失败一律转成 ENGINE_LOAD_FAILED，并带上原始错误（不含凭据） */
export async function loadBaileysModules(dir: string): Promise<BaileysModules> {
  const found = inspectDir(dir)
  if (!found) {
    throw new AppError(503, 'ENGINE_NOT_INSTALLED', `WhatsApp 引擎目录不完整：${dir} 下缺少 baileys`)
  }
  try {
    const require = createRequire(join(dir, 'package.json'))
    const baileysEntry = require.resolve(found.packageName)
    const baileys = (await import(pathToFileURL(baileysEntry).href)) as any
    const root = baileys.default?.default ?? baileys.default ?? baileys
    const makeWASocket = root.makeWASocket ?? root.default ?? baileys.makeWASocket
    const useMultiFileAuthState = baileys.useMultiFileAuthState ?? root.useMultiFileAuthState
    if (typeof makeWASocket !== 'function' || typeof useMultiFileAuthState !== 'function') {
      throw new Error('baileys 模块缺少 makeWASocket / useMultiFileAuthState')
    }

    const qrEntry = require.resolve('qrcode')
    const qrModule = (await import(pathToFileURL(qrEntry).href)) as any
    const qr = qrModule.default ?? qrModule
    if (typeof qr.toDataURL !== 'function') throw new Error('qrcode 模块缺少 toDataURL')

    return {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason: baileys.DisconnectReason ?? root.DisconnectReason,
      fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion ?? root.fetchLatestBaileysVersion,
      toDataUrl: (text, options) => qr.toDataURL(text, options),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new AppError(
      503,
      'ENGINE_LOAD_FAILED',
      `WhatsApp 引擎加载失败：${reason}。请检查引擎版本与二维码依赖（qrcode）是否安装完整`,
      undefined,
      { dir },
    )
  }
}

export function createDefaultEngineFactory(): WhatsAppEngineFactory {
  return ({ engineDir }) => {
    if (!engineDir) {
      const info = inspectEngine()
      throw new AppError(
        503,
        info.error?.code ?? 'ENGINE_NOT_INSTALLED',
        info.error?.message ?? 'WhatsApp 引擎尚未安装',
      )
    }
    // 适配器模块本身只依赖 node 内置模块；真实 baileys 在 start() 里才动态 import
    return new BaileysAdapter(engineDir)
  }
}
