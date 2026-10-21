import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { onApiError, onPasswordChangeRequired, onUnauthorized } from './api'
import { i18n } from './i18n'
import { applyAppearance, loadAppearance } from './lib/appearance'
import { isChunkLoadError, reportFatal } from './lib/fatal-error'
import { vPerm } from './lib/perm-directive'
import { auth, clearSession } from './lib/session'
import { router } from './router'
import { platform, trafficLightInset, windowChrome } from './lib/window'
import { toast } from './stores/ui'
import './styles.css'

applyAppearance(loadAppearance())
// 标题栏形态（契约 §9.1）：样式按 data-chrome 留出 mac 红绿灯 / Windows 右上角按钮的位置
document.documentElement.dataset.chrome = windowChrome
document.documentElement.dataset.platform = platform || 'web'
document.documentElement.style.setProperty('--traffic-light-inset', `${trafficLightInset}px`)
onApiError((error) => toast.error(error.message, error.requestId))
// server 模式会话过期：清掉 token 回登录页（契约 §5.4）
onUnauthorized(async () => {
  await clearSession()
  if (router.currentRoute.value.name !== 'login') {
    await router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

// 管理员设置的临时密码：服务端拒绝改密以外的接口，跳到改密页
onPasswordChangeRequired(async () => {
  if (auth.me) auth.me.user.mustChangePassword = true
  if (router.currentRoute.value.name !== 'change-password') {
    await router.replace({ name: 'change-password', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

const app = createApp(App)
app.config.errorHandler = (error) => {
  console.error(error)
  toast.error(error instanceof Error ? error.message : String(error))
}

// 更新后旧页面拉不到新的代码块：给出“重新加载”而不是卡在空白页
router.onError((error) => {
  if (isChunkLoadError(error)) reportFatal(error)
  else console.error(error)
})

app.directive('perm', vPerm)
app.use(i18n)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 开发态暴露路由，供 e2e 测试判断页面就绪（生产构建会被摇树去掉）
if (import.meta.env.DEV) (window as unknown as { __luluxRouter: typeof router }).__luluxRouter = router
