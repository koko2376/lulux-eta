/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 数据目录与服务端保持一致（packages/server/src/config.ts）：
 * LULUX_DATA_DIR（契约名）> LULUX_ETA_HOME（服务端现用名）> ~/.lulux-eta
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LULUX_DATA_DIR || env.LULUX_ETA_HOME || join(homedir(), '.lulux-eta')
}

/** 每次请求都重新读 token：服务端重启会重新生成 */
function readApiToken(): string {
  if (process.env.LULUX_API_TOKEN) return process.env.LULUX_API_TOKEN
  try {
    return readFileSync(join(resolveDataDir(), 'api-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

const apiTarget = process.env.LULUX_API_TARGET || 'http://127.0.0.1:51789'
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

/**
 * index.html 里写的是生产 CSP（只允许同源）。开发态 Vite 需要 HMR websocket，
 * 这里只在 serve 时放宽 connect-src。
 */
function devCsp(): Plugin {
  return {
    name: 'lulux-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "connect-src 'self'",
        "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
      )
    },
  }
}

export default defineConfig({
  plugins: [vue(), devCsp()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // vue-i18n：只用组合式 API；文案由 src/i18n 的自定义编译器处理，运行时不需要消息编译器（也不需要 eval，符合 CSP）
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  resolve: {
    alias: { 'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js' },
  },
  server: {
    port: 51790,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const token = readApiToken()
            if (token && !proxyReq.getHeader('authorization')) {
              proxyReq.setHeader('Authorization', `Bearer ${token}`)
            }
            // 浏览器发出的 Origin 是 Vite 的 51790，服务端只认自身 origin；
            // 代理请求等价于同源请求，改写为目标 origin。只改写本机回环 origin：其他网页（任意站点）发来的
            // 跨源请求原样转发，由服务端以 ORIGIN_NOT_ALLOWED 拒绝——否则代理会替它补上 token 和可信 origin。
            const origin = proxyReq.getHeader('origin')
            if (typeof origin === 'string' && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
              proxyReq.setHeader('Origin', apiTarget)
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
})
