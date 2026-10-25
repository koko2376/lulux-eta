import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * 端到端测试：默认在真服务上跑（packages/server 源码 + 假模型 + 本机测试邮件服务 + vite dev）。
 * - 两套服务端：desktop 模式（主流程、邮箱）与 server 模式（团队、角色）
 * - 每次运行使用全新的临时数据目录（E2E_DATA_DIR 可覆盖）
 * - 端口都可用环境变量覆盖，默认避开开发常用的 51789/51790
 * - E2E_REUSE=1 时复用已在跑的服务；E2E_MOCK=1 时 desktop 服务改用客户端自带的契约 mock
 */
const dataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'lulux-e2e-'))
const serverDataDir = process.env.E2E_SERVER_DATA_DIR || mkdtempSync(join(tmpdir(), 'lulux-e2e-team-'))
process.env.E2E_DATA_DIR = dataDir
process.env.E2E_SERVER_DATA_DIR = serverDataDir

export const PORTS = {
  api: Number(process.env.E2E_API_PORT || 52789),
  web: Number(process.env.E2E_WEB_PORT || 52790),
  teamApi: Number(process.env.E2E_TEAM_API_PORT || 52889),
  teamWeb: Number(process.env.E2E_TEAM_WEB_PORT || 52891),
  chatLlm: Number(process.env.E2E_CHAT_LLM_PORT || 52998),
  mailLlm: Number(process.env.E2E_MAIL_LLM_PORT || 52999),
  imap: Number(process.env.E2E_IMAP_PORT || 52143),
  smtp: Number(process.env.E2E_SMTP_PORT || 52025),
}
for (const [k, v] of Object.entries(PORTS)) process.env[`E2E_PORT_${k.toUpperCase()}`] = String(v)

const reuse = process.env.E2E_REUSE === '1'
const useMock = process.env.E2E_MOCK === '1'
const base = { NODE_ENV: 'development' }
const desktopEnv = { ...base, LULUX_ETA_HOME: dataDir, LULUX_DATA_DIR: dataDir, LULUX_ETA_PORT: String(PORTS.api) }
const teamEnv = {
  ...base,
  LULUX_MODE: 'server',
  LULUX_PUBLIC_ORIGIN: `http://localhost:${PORTS.teamWeb}`,
  LULUX_ETA_HOME: serverDataDir,
  LULUX_DATA_DIR: serverDataDir,
  LULUX_ETA_PORT: String(PORTS.teamApi),
}

/** globalSetup 建好的 e2e 本机账户会话（workers 从环境变量继承；见 e2e/fixtures/local-account.ts） */
const localSession = process.env.E2E_LOCAL_SESSION

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/fixtures/global-setup.ts',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORTS.web}`,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    extraHTTPHeaders: localSession ? { 'X-Lulux-Session': localSession } : {},
  },
  webServer: [
    useMock
      ? { command: `node mock/server.mjs ${PORTS.api}`, port: PORTS.api, reuseExistingServer: reuse, env: desktopEnv }
      : {
          command: 'npx tsx ../server/src/index.ts',
          port: PORTS.api,
          reuseExistingServer: reuse,
          env: desktopEnv,
          timeout: 60_000,
        },
    {
      command: 'npx tsx ../server/src/index.ts',
      port: PORTS.teamApi,
      reuseExistingServer: reuse,
      env: teamEnv,
      timeout: 60_000,
    },
    {
      command: `node ../../tools/dev/mock-openai.js ${PORTS.chatLlm}`,
      port: PORTS.chatLlm,
      reuseExistingServer: reuse,
    },
    { command: `node e2e/fixtures/mock-llm.mjs ${PORTS.mailLlm}`, port: PORTS.mailLlm, reuseExistingServer: reuse },
    {
      command: `node e2e/fixtures/mail-server.mjs ${PORTS.imap} ${PORTS.smtp}`,
      port: PORTS.smtp,
      reuseExistingServer: reuse,
    },
    {
      command: `npx vite --port ${PORTS.web} --strictPort`,
      port: PORTS.web,
      reuseExistingServer: reuse,
      env: { ...desktopEnv, LULUX_API_TARGET: `http://127.0.0.1:${PORTS.api}` },
    },
    {
      command: `npx vite --port ${PORTS.teamWeb} --strictPort`,
      port: PORTS.teamWeb,
      reuseExistingServer: reuse,
      env: { ...teamEnv, LULUX_API_TARGET: `http://127.0.0.1:${PORTS.teamApi}` },
    },
  ],
})
