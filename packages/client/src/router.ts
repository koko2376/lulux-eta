import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from './layouts/AppLayout.vue'
import { checkLock, needsUnlock } from './lib/lock'
import { auth, initAuth } from './lib/session'
import { uiState } from './stores/ui'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/unlock', name: 'unlock', component: () => import('./views/UnlockView.vue') },
    // 团队服务器登录（契约 §5）；desktop 模式下也可从这里连接远程服务器
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/join', name: 'join', component: () => import('./views/JoinView.vue'), meta: { public: true } },
    // 管理员设置 / 重置的临时密码：先改密才能进入
    { path: '/change-password', name: 'change-password', component: () => import('./views/ChangePasswordView.vue') },
    { path: '/login/remote', redirect: '/login' },
    // 内核选择统一到设置页
    { path: '/agent/kernels', redirect: '/settings/kernels' },
    {
      path: '/',
      component: AppLayout,
      children: [
        {
          path: '',
          name: 'workbench',
          component: () => import('./views/WorkbenchView.vue'),
          meta: { section: 'workbench' },
        },
        {
          path: 'customers',
          name: 'customers',
          component: () => import('./views/CustomersView.vue'),
          meta: { section: 'customers' },
        },
        {
          path: 'customers/import',
          name: 'customers-import',
          component: () => import('./views/CustomersImportView.vue'),
          meta: { section: 'customers' },
        },
        {
          path: 'customers/:id',
          name: 'customer-detail',
          component: () => import('./views/CustomerDetailView.vue'),
          meta: { section: 'customers' },
        },
        {
          path: 'quotation/:id?',
          name: 'quotation',
          component: () => import('./views/QuotationView.vue'),
          meta: { section: 'quotation' },
        },
        {
          path: 'products',
          name: 'products',
          component: () => import('./views/ProductsView.vue'),
          meta: { section: 'quotation' },
        },
        {
          path: 'deals',
          name: 'deals',
          component: () => import('./views/DealsView.vue'),
          meta: { section: 'deals' },
        },
        {
          path: 'orders/:id?',
          name: 'orders',
          component: () => import('./views/OrdersView.vue'),
          meta: { section: 'orders' },
        },
        {
          path: 'mailbox',
          name: 'mailbox',
          component: () => import('./views/MailboxView.vue'),
          meta: { section: 'mailbox' },
        },
        {
          path: 'workflows/:id?',
          name: 'workflows',
          component: () => import('./views/WorkflowsView.vue'),
          meta: { section: 'workflows' },
        },
        {
          path: 'schedules',
          name: 'schedules',
          component: () => import('./views/SchedulesView.vue'),
          meta: { section: 'schedules' },
        },
        {
          path: 'skills',
          name: 'skills',
          component: () => import('./views/SkillsView.vue'),
          meta: { section: 'skills' },
        },
        {
          path: 'skills/agents',
          name: 'skills-agents',
          component: () => import('./views/AgentSkillsView.vue'),
          meta: { section: 'skills' },
        },
        {
          path: 'agent',
          name: 'agent',
          component: () => import('./views/AgentView.vue'),
          meta: { section: 'agent' },
        },
        { path: 'settings', redirect: '/settings/models' },
        {
          path: 'settings/kernels',
          name: 'settings-kernels',
          component: () => import('./views/SettingsKernelView.vue'),
          meta: { section: 'settings', settings: 'kernels' },
        },
        {
          path: 'settings/account',
          name: 'settings-account',
          component: () => import('./views/SettingsAccountView.vue'),
          meta: { section: 'settings', settings: 'account' },
        },
        {
          path: 'settings/mailbox',
          name: 'settings-mailbox',
          component: () => import('./views/SettingsMailboxView.vue'),
          meta: { section: 'settings', settings: 'mailbox' },
        },
        {
          path: 'settings/models',
          name: 'settings-models',
          component: () => import('./views/SettingsModelsView.vue'),
          meta: { section: 'settings', settings: 'models' },
        },
        {
          path: 'settings/builtin',
          name: 'settings-builtin',
          component: () => import('./views/SettingsBuiltinView.vue'),
          meta: { section: 'settings', settings: 'builtin' },
        },
        {
          path: 'settings/memory',
          name: 'settings-memory',
          component: () => import('./views/SettingsMemoryView.vue'),
          meta: { section: 'settings', settings: 'memory' },
        },
        {
          path: 'settings/usage',
          name: 'settings-usage',
          component: () => import('./views/SettingsUsageView.vue'),
          meta: { section: 'settings', settings: 'usage' },
        },
        {
          path: 'settings/mcp',
          name: 'settings-mcp',
          component: () => import('./views/SettingsMcpView.vue'),
          meta: { section: 'settings', settings: 'mcp' },
        },
        {
          path: 'settings/network',
          name: 'settings-network',
          component: () => import('./views/SettingsNetworkView.vue'),
          meta: { section: 'settings', settings: 'network' },
        },
        {
          path: 'settings/rules',
          name: 'settings-rules',
          component: () => import('./views/SettingsRulesView.vue'),
          meta: { section: 'settings', settings: 'rules' },
        },
        {
          path: 'settings/templates',
          name: 'settings-templates',
          component: () => import('./views/SettingsTemplatesView.vue'),
          meta: { section: 'settings', settings: 'templates' },
        },
        {
          path: 'settings/backup',
          name: 'settings-backup',
          component: () => import('./views/SettingsBackupView.vue'),
          meta: { section: 'settings', settings: 'backup' },
        },
        {
          path: 'settings/trash',
          name: 'settings-trash',
          component: () => import('./views/SettingsTrashView.vue'),
          meta: { section: 'settings', settings: 'trash' },
        },
        {
          path: 'settings/team',
          name: 'settings-team',
          component: () => import('./views/SettingsTeamView.vue'),
          meta: { section: 'settings', settings: 'team' },
        },
        {
          path: 'settings/appearance',
          name: 'settings-appearance',
          component: () => import('./views/SettingsAppearanceView.vue'),
          meta: { section: 'settings', settings: 'appearance' },
        },
        {
          path: 'settings/desktop',
          name: 'settings-desktop',
          component: () => import('./views/SettingsDesktopView.vue'),
          meta: { section: 'settings', settings: 'desktop' },
        },
        {
          path: 'settings/about',
          name: 'settings-about',
          component: () => import('./views/SettingsAboutView.vue'),
          meta: { section: 'settings', settings: 'about' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// vue-router 在首个导航完成后才开始监听 hashchange，且首个导航结束时会用启动时的地址 replace 地址栏：
// 首屏守卫（initAuth 等）未结束时 hash 被改动（深链接、e2e 连续 goto）会被覆盖，页面停在初始路由。
// 记下就绪前最后一次 hash 变化，就绪后补一次跳转。
let hashBeforeReady: string | null = null
const rememberHash = (): void => {
  hashBeforeReady = window.location.hash
}
window.addEventListener('hashchange', rememberHash)
void router.isReady().then(() => {
  window.removeEventListener('hashchange', rememberHash)
  if (hashBeforeReady === null) return
  const want = decodeURI(hashBeforeReady.replace(/^#/, '')) || '/'
  if (want !== router.currentRoute.value.fullPath) void router.replace(want).catch(() => undefined)
})

// 页面切换时关闭残留的确认框（否则遮罩会盖住新页面，且旧操作的 Promise 永不结束）
router.afterEach(() => {
  uiState.confirm?.resolve(false)
})

router.beforeEach(async (to) => {
  await initAuth()
  if (auth.mode === 'server') {
    // 团队服务器：未登录只能看登录 / 加入页；本机锁不适用
    if (!auth.me && !to.meta.public) {
      return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
    }
    if (auth.me && to.name === 'unlock') return { path: '/' }
    if (auth.me?.user.mustChangePassword) {
      if (to.name === 'change-password' || to.name === 'login') return true
      return { name: 'change-password', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
    }
    if (to.name === 'change-password') return { path: '/' }
    return true
  }
  if (to.meta.public) return true
  // 本机：没有有效的本机会话 → 登录页“LULUX”（本机）栏；还没有账户时那里直接是“创建本机账户”
  if (!auth.me) {
    return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }
  if (to.name === 'change-password') return { path: '/' }
  await checkLock()
  if (needsUnlock() && to.name !== 'unlock') {
    return { name: 'unlock', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }
  if (!needsUnlock() && to.name === 'unlock') return { path: '/' }
  return true
})
