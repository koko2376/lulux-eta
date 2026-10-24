<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import logoUrl from '../assets/lulux-neutral.png'
import RecoveryCodeDialog from '../components/RecoveryCodeDialog.vue'
import '../styles/auth-orig.css'
import { checkLock } from '../lib/lock'
import { loginPrefs, rememberLocalLogin, rememberServerLogin } from '../lib/login-prefs'
import {
  auth,
  connectServer,
  currentServerOrigin,
  probeServer,
  recentServers,
  saveLocalSession,
  saveSession,
  useLocalServer,
  validateServerUrl,
} from '../lib/session'
import { checkCompat, clientVersion, compatMessage, fetchServerVersion, versionCompat } from '../lib/version-compat'
import { errorText } from '../stores/ui'
import { LOCALE_NAMES, LOCALES, loadLanguagePref, locale, setLanguage, t, type Locale } from '../i18n'
import { markWelcomed, welcomedThisWindow } from '../lib/welcome'

/**
 * 登录页：本机 / 连接服务器两种登录（同一页里用分段开关切换），接真实行为。
 *
 * - 本机：用户名 + 密码（本机账户，存在这台电脑的库里，/api/auth/local/*）。
 *   “首次使用，创建本机账户”切到同样版式的创建表单（用户名、密码、确认密码），创建后直接登录。
 *   这台电脑还没有本机账户时（全新安装，或早期测试版留下的数据）直接打开创建表单；桌面端每次启动都先到这里，
 *   只有勾了“记住这台机器”的会话会跳过（默认不勾）。本机数据属于同一个本机用户，建账户不丢数据。
 *   远程连接时先切回本机再登录。网页由团队服务器同源提供时没有本机模式，如实提示。
 *   “忘记密码？”：用户名 + 恢复码 + 新密码；恢复码也丢了时，在数据目录放 RESET-LOCAL-PASSWORD 文件后可直接设新密码。
 *   创建账户、找回密码、早期账户首次登录时服务端会发一次性恢复码：先弹窗让用户保存，点“我已保存”才进入。
 * - 连接服务器：服务器地址 + 邮箱 + 密码，真实的团队服务器登录（https，localhost 例外）；
 *   服务器未初始化时出现“初始化团队服务器”表单；“测试连接”只探测不切换。
 * - 进场动画：标志、品牌名、分段开关、表单逐行淡入升起；登录成功后整页淡出再进入。减少动画时只做淡入。
 * - 记住（默认不勾）：按登录方式分别记，团队服务器按地址分别记（lib/login-prefs.ts）。勾上时记下登录方式 /
 *   本机用户名 / 服务器邮箱，下次预填并预先勾上；同时决定会话是否跨重启保存（桌面端由主进程保管）。
 *   记住的会话失效（过期 / 登出）回到这里时：预填用户名、保持勾选、光标直接在密码框。
 */

type Tab = 'local' | 'server'
const PENDING_KEY = 'lulux.login.pending'

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

const route = useRoute()
const router = useRouter()
const redirect = computed(() => (typeof route.query.redirect === 'string' ? route.query.redirect : '/'))

const prefs = loginPrefs()
/** 桌面端切换服务器会重载窗口：重载前暂存邮箱，重载后预填（密码不暂存） */
const pending = readJson<{ email?: string; username?: string; remember?: boolean; tab?: Tab }>(
  sessionStorage,
  PENDING_KEY,
)
sessionStorage.removeItem(PENDING_KEY)

const tab = ref<Tab>(
  pending?.tab ?? (auth.mode === 'server' || auth.connection === 'remote' ? 'server' : (prefs.tab ?? 'local')),
)
/** 这台服务器上次是否勾了“记住” */
const serverRemembered = (url: string): boolean => Boolean(url) && prefs.servers?.[url]?.remember === true
/** 记住：默认不勾（每次打开都先到登录页）；只有这种登录方式（这台服务器）上次明确勾过才预先勾上 */
function rememberedFor(which: Tab, url = ''): boolean {
  return which === 'local' ? prefs.local?.remember === true : serverRemembered(url)
}
const remember = ref(false)
const notice = ref(
  pending?.tab !== 'local' && pending && auth.serverUrl ? t('authx.reconnected', [auth.serverUrl]) : '',
)

const LOGIN_ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: t('login.k1rw8gbl'),
  USER_DISABLED: t('login.k19g58xf'),
  SETUP_REQUIRED: t('login.k1qmph9c'),
  SETUP_TOKEN_INVALID: t('login.kywt5q'),
  SETUP_ALREADY_DONE: t('login.k1rurnky'),
  WEAK_PASSWORD: t('login.kr05pd5'),
}
function describe(error: unknown): string {
  if (error instanceof api.ApiError) {
    if (error.code === 'LOGIN_RATE_LIMITED') return t('login.kkg0axh')
    return LOGIN_ERRORS[error.code] ?? error.message
  }
  return errorText(error)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* ── 本机 ── */
/** 网页由同源的团队服务器提供：没有本机服务可切 */
const localUnavailable = computed(() => auth.mode === 'server' && auth.connection === 'local')
const localDirect = computed(() => auth.mode === 'desktop' && auth.connection === 'local')
/** 只有直连本机服务时才知道有没有本机账户；远程连接时先切回本机再判断 */
const hasLocalAccount = computed(() => localDirect.value && auth.local.hasAccount)
/** 这台电脑还没有本机账户（全新安装 / 早期测试版的数据）：直接打开创建表单 */
const needsAccount = computed(() => localDirect.value && !auth.local.hasAccount)
const localView = ref<'login' | 'create' | 'forgot'>(
  route.query.create === '1' || needsAccount.value ? 'create' : 'login',
)
const local = reactive({
  username: pending?.username || auth.local.username || prefs.local?.username || '',
  password: '',
  confirm: '',
  recoveryCode: '',
})
const localErrors = reactive({ username: '', password: '', confirm: '', recoveryCode: '', form: '' })
const localBusy = ref(false)
const learnOpen = ref(false)
const USERNAME_RE = /^[\p{L}\p{N}._-]{2,32}$/u

const LOCAL_ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: t('authx.localInvalid'),
  LOGIN_RATE_LIMITED: t('authx.localRateLimited'),
  USERNAME_TAKEN: t('authx.usernameTaken'),
  USERNAME_INVALID: t('authx.usernameRule'),
  LOCAL_ACCOUNT_EXISTS: t('authx.accountExists'),
  WEAK_PASSWORD: t('authx.weakPassword'),
  RECOVERY_CODE_INVALID: t('authx.recoveryInvalid'),
  RESET_FILE_MISSING: t('authx.resetFileMissing'),
  RESET_FILE_LOCKED: t('authx.resetFileLocked'),
  LOCAL_ACCOUNT_NOT_FOUND: t('authx.localAccountNotFound'),
}
function describeLocal(error: unknown): string {
  if (error instanceof api.ApiError) return LOCAL_ERRORS[error.code] ?? error.message
  return errorText(error)
}

function clearLocalErrors(): void {
  localErrors.username = localErrors.password = localErrors.confirm = localErrors.recoveryCode = localErrors.form = ''
}

/** 远程连接时先切回本机。桌面端主进程会重载窗口：返回 false，之后的代码不再有意义 */
async function ensureLocal(): Promise<boolean> {
  if (auth.connection !== 'remote') return true
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ tab: 'local', username: local.username.trim(), remember: remember.value }),
  )
  await useLocalServer()
  if (auth.connection === 'remote') return false
  sessionStorage.removeItem(PENDING_KEY)
  await checkLock(true)
  return true
}

async function submitLocal(): Promise<void> {
  clearLocalErrors()
  if (localUnavailable.value || localBusy.value) return
  localBusy.value = true
  try {
    if (!(await ensureLocal())) return
    const username = local.username.trim()
    if (!username) localErrors.username = t('authx.usernameRequired')
    if (!local.password) localErrors.password = t('authx.passwordRequired')
    if (localErrors.username || localErrors.password) return
    const result = await api.localLogin(username, local.password, remember.value)
    rememberLocalLogin(result.account.username, remember.value)
    await saveLocalSession(result, { persist: remember.value })
    await finishLocal(result, 'legacy')
  } catch (e) {
    localErrors.form = describeLocal(e)
    local.password = ''
  } finally {
    localBusy.value = false
  }
}

async function submitCreate(): Promise<void> {
  clearLocalErrors()
  if (localUnavailable.value || localBusy.value) return
  const username = local.username.trim()
  if (!username) localErrors.username = t('authx.usernameRequired')
  else if (!USERNAME_RE.test(username.normalize('NFKC'))) localErrors.username = t('authx.usernameRule')
  if (!local.password) localErrors.password = t('authx.passwordRequired')
  else if (local.password.length < 8) localErrors.password = t('authx.passwordTooShort')
  if (!localErrors.password && local.confirm !== local.password) localErrors.confirm = t('authx.passwordMismatch')
  if (localErrors.username || localErrors.password || localErrors.confirm) return
  localBusy.value = true
  try {
    if (!(await ensureLocal())) return
    const result = await api.createLocalAccount(username, local.password, remember.value)
    rememberLocalLogin(result.account.username, remember.value)
    await saveLocalSession(result, { persist: remember.value })
    await finishLocal(result, 'created')
  } catch (e) {
    if (e instanceof api.ApiError && e.code === 'USERNAME_TAKEN') localErrors.username = describeLocal(e)
    else localErrors.form = describeLocal(e)
  } finally {
    localBusy.value = false
  }
}

function pickLocalView(next: 'login' | 'create' | 'forgot'): void {
  localView.value = next
  local.password = local.confirm = local.recoveryCode = ''
  clearLocalErrors()
}

/* ── 一次性恢复码：保存后才进入 ── */
const issuedCode = ref<{ code: string; reason: 'created' | 'reset' | 'legacy' } | null>(null)
async function finishLocal(result: api.LocalLoginResult, reason: 'created' | 'reset' | 'legacy'): Promise<void> {
  if (result.recoveryCode) {
    issuedCode.value = { code: result.recoveryCode, reason }
    return
  }
  await leaveTo(redirect.value)
}
async function recoveryCodeSaved(): Promise<void> {
  issuedCode.value = null
  await leaveTo(redirect.value)
}

/* ── 忘记密码：恢复码；恢复码也丢了 → 数据目录里的 RESET-LOCAL-PASSWORD 文件 ── */
const recoveryInfo = ref<api.LocalRecoveryInfo | null>(null)
const recoveryInfoError = ref('')
const lostCodeOpen = ref(false)
const pathCopied = ref(false)
const fileReset = computed(() => recoveryInfo.value?.resetFilePresent === true)

async function loadRecoveryInfo(): Promise<void> {
  recoveryInfoError.value = ''
  try {
    recoveryInfo.value = await api.getLocalRecoveryInfo()
  } catch (e) {
    recoveryInfoError.value = describeLocal(e)
  }
}

async function openForgot(): Promise<void> {
  if (localUnavailable.value || localBusy.value) return
  if (!(await ensureLocal())) return
  pickLocalView('forgot')
  lostCodeOpen.value = false
  await loadRecoveryInfo()
}

async function copyDataDir(): Promise<void> {
  const dir = recoveryInfo.value?.dataDir
  if (!dir) return
  try {
    await navigator.clipboard.writeText(dir)
    pathCopied.value = true
  } catch {
    pathCopied.value = false
  }
}

async function submitForgot(): Promise<void> {
  clearLocalErrors()
  if (localUnavailable.value || localBusy.value) return
  const username = local.username.trim()
  if (!username) localErrors.username = t('authx.usernameRequired')
  if (!fileReset.value && !local.recoveryCode.trim()) localErrors.recoveryCode = t('authx.recoveryCodeRequired')
  if (!local.password) localErrors.password = t('authx.passwordRequired')
  else if (local.password.length < 8) localErrors.password = t('authx.passwordTooShort')
  if (!localErrors.password && local.confirm !== local.password) localErrors.confirm = t('authx.passwordMismatch')
  if (localErrors.username || localErrors.recoveryCode || localErrors.password || localErrors.confirm) return
  localBusy.value = true
  try {
    if (!(await ensureLocal())) return
    const result = fileReset.value
      ? await api.resetLocalPasswordWithFile({ username, newPassword: local.password, remember: remember.value })
      : await api.recoverLocalPassword({
          username,
          recoveryCode: local.recoveryCode.trim(),
          newPassword: local.password,
          remember: remember.value,
        })
    rememberLocalLogin(result.account.username, remember.value)
    await saveLocalSession(result, { persist: remember.value })
    local.password = local.confirm = local.recoveryCode = ''
    await finishLocal(result, 'reset')
  } catch (e) {
    localErrors.form = describeLocal(e)
    if (e instanceof api.ApiError && e.code === 'RESET_FILE_MISSING') await loadRecoveryInfo()
  } finally {
    localBusy.value = false
  }
}

/* ── 连接服务器 ── */
const recents = recentServers()
const initialServer = currentServerOrigin() || prefs.lastServer || recents[0] || ''
const server = reactive({
  url: initialServer,
  email: pending?.email ?? prefs.servers?.[initialServer]?.email ?? '',
  password: '',
})
remember.value = pending?.remember ?? rememberedFor(tab.value, initialServer)
// 换了服务器地址：带出这台服务器记住的邮箱与勾选（没记过的地址不改用户已填的内容）
watch(
  () => server.url.trim().replace(/\/+$/, ''),
  (url) => {
    if (tab.value !== 'server') return
    const saved = prefs.servers?.[url]
    if (!saved) return
    remember.value = saved.remember === true
    if (!server.email && saved.email) server.email = saved.email
  },
)
const errors = reactive({ url: '', email: '', password: '', form: '' })
const busy = ref(false)
const testing = ref(false)
const testResult = ref('')
const setupDismissed = ref(false)
const passwordInput = ref<HTMLInputElement | null>(null)
const localPasswordInput = ref<HTMLInputElement | null>(null)

const sameServer = (url: string) => Boolean(url) && url === currentServerOrigin()
const showSetup = computed(
  () =>
    tab.value === 'server' &&
    auth.mode === 'server' &&
    auth.setupRequired &&
    !setupDismissed.value &&
    sameServer(currentServerOrigin()),
)

function validateServerForm(needCredentials: boolean): string | null {
  errors.url = errors.email = errors.password = errors.form = ''
  let url: string | null = null
  if (!server.url.trim()) errors.url = t('authx.serverUrlRequired')
  else {
    const checked = validateServerUrl(server.url)
    if (checked.error !== undefined) errors.url = checked.error
    else url = checked.url
  }
  if (needCredentials) {
    if (!server.email.trim()) errors.email = t('authx.emailRequired')
    else if (!EMAIL_RE.test(server.email.trim())) errors.email = t('authx.emailInvalid')
    if (!server.password) errors.password = t('authx.passwordRequired')
  }
  return errors.url || errors.email || errors.password ? null : url
}

async function submitServer(): Promise<void> {
  notice.value = ''
  testResult.value = ''
  const url = validateServerForm(true)
  if (!url || busy.value) return
  busy.value = true
  try {
    if (!sameServer(url)) {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ email: server.email.trim(), remember: remember.value }))
      const res = await connectServer(url)
      if (!res.ok) {
        sessionStorage.removeItem(PENDING_KEY)
        errors.url = res.error ?? t('login.kc7prmg')
        return
      }
      if (res.reloading) return // 桌面端：窗口马上按新连接重载，邮箱已暂存
      sessionStorage.removeItem(PENDING_KEY)
    }
    // 版本兼容：低于服务器的最低客户端版本时不登录；主 / 次版本不同只提示
    if (!(await versionGate(url))) return
    if (auth.setupRequired) {
      setupDismissed.value = false
      setup.email = server.email.trim()
      setup.password = server.password
      return
    }
    const session = await api.login(server.email.trim(), server.password)
    rememberServerLogin(url, server.email.trim(), remember.value)
    await saveSession(session, { persist: remember.value })
    await leaveTo(redirect.value)
  } catch (e) {
    errors.form = describe(e)
  } finally {
    busy.value = false
  }
}

async function testConnection(): Promise<void> {
  testResult.value = ''
  const url = validateServerForm(false)
  if (!url || testing.value) return
  testing.value = true
  try {
    const res = await probeServer(url)
    if (!res.ok) errors.url = res.error
    else {
      testResult.value = t(res.setupRequired ? 'authx.testOkSetup' : 'authx.testOk', [res.version || '?'])
      await versionGate(url)
    }
  } finally {
    testing.value = false
  }
}

/* ── 版本兼容（客户端 vs 团队服务器） ── */
const compatNote = ref('')
const compatBlocked = ref(false)
async function versionGate(url: string): Promise<boolean> {
  compatNote.value = ''
  compatBlocked.value = false
  const info = await fetchServerVersion(url)
  if (!info) return true
  const result = checkCompat(clientVersion(), info)
  versionCompat.result = result
  versionCompat.checkedAt = Date.now()
  compatNote.value = compatMessage(result)
  compatBlocked.value = result.status === 'blocked'
  return !compatBlocked.value
}

/* ── 初始化所有者（服务器还没有账号） ── */
const setup = reactive({ setupToken: '', orgName: '', name: '', email: '', password: '' })
const setupError = ref('')
async function submitSetup(): Promise<void> {
  setupError.value = ''
  if (Object.values(setup).some((v) => !v.trim())) return void (setupError.value = t('login.kfqwi8k'))
  busy.value = true
  try {
    await saveSession(await api.setupOwner({ ...setup, email: setup.email.trim() }), { persist: remember.value })
    await router.replace('/settings/team')
  } catch (e) {
    setupError.value = describe(e)
  } finally {
    busy.value = false
  }
}

/* ── 动画：进场（品牌 → 分段开关 → 表单逐行升起），登录成功后淡出再进入 ── */
const leaving = ref(false)
/** 进场动画只在打开页面时播放一次（之后切换栏 / 表单不再逐行升起） */
const intro = ref(true)
const INTRO_MS = 1400
/** 登录成功的离场动画时长；减少动画（系统或 设置 → 外观）时不等 */
const LEAVE_MS = 360
function reducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('reduce-motion')) return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
async function leaveTo(path: string): Promise<void> {
  if (!reducedMotion() && import.meta.env.MODE !== 'test') {
    leaving.value = true
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS))
  }
  await router.replace(path)
}

/* ── 界面语言（右上角）：与 设置 → 外观 的语言是同一个偏好，登录后照样生效 ── */
const languageOptions = LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))
const currentLanguage = computed(() => LOCALE_NAMES[locale.value])
function chooseLanguage(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as Locale
  if (!LOCALES.includes(value)) return
  // 已是“跟随系统”且解析结果相同：不改偏好
  if (value === locale.value && loadLanguagePref() === 'system') return
  setLanguage(value)
}

function pickTab(next: Tab): void {
  if (next !== tab.value) remember.value = rememberedFor(next, server.url.trim().replace(/\/+$/, ''))
  tab.value = next
  localErrors.form = errors.form = ''
}

/*
 * 欢迎页（开屏）：每次启动软件第一次看到登录页时，先是居中的大标志 + 品牌名 + 一句话 + 胶囊「登录 →」，
 * 点一下再展开登录表单。会话过期回来 / 预填了账号 / 带 redirect / 单测里不显示，直接是表单。
 */
function shouldWelcome(): boolean {
  if (import.meta.env.MODE === 'test' || pending || route.query.redirect) return false
  return !welcomedThisWindow()
}
const welcome = ref(shouldWelcome())
const welcomeButton = ref<HTMLButtonElement | null>(null)
async function startFromWelcome(): Promise<void> {
  markWelcomed()
  welcome.value = false
  intro.value = true
  setTimeout(() => (intro.value = false), INTRO_MS)
  await nextTick()
  // 光标放到第一个还没填的输入框（用户名已记住就直接到密码）
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('.auth-orig .ao-form input:not([type=checkbox])'),
  )
  ;(inputs.find((input) => !input.value && !input.disabled) ?? inputs[0])?.focus()
}

onMounted(async () => {
  if (welcome.value) void nextTick(() => welcomeButton.value?.focus())
  setTimeout(() => (intro.value = false), INTRO_MS)
  if (localDirect.value) await checkLock(true)
  // 切服务器重载回来，或记住的会话失效回到登录页（用户名 / 邮箱已预填）：光标直接放到密码框
  const prefilled =
    tab.value === 'server' ? Boolean(server.email) : localView.value === 'login' && Boolean(local.username)
  if (pending || prefilled) {
    await nextTick()
    ;(tab.value === 'server' ? passwordInput.value : localPasswordInput.value)?.focus()
  }
})
</script>

<template>
  <main class="auth-orig ao-page" :class="{ 'ao-intro': intro, 'ao-leaving': leaving }" data-testid="login-page">
    <div class="ao-topbar">
      <label class="ao-lang" data-testid="login-language" :title="$t('settingsAppearance.language')">
        <svg class="ao-lang-globe" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9" />
        </svg>
        <span class="ao-lang-name">{{ currentLanguage }}</span>
        <svg class="ao-lang-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
        <select
          :value="locale"
          name="language"
          data-testid="login-language-select"
          :aria-label="$t('settingsAppearance.language')"
          @change="chooseLanguage"
        >
          <option v-for="o in languageOptions" :key="o.value" :value="o.value" :lang="o.value">{{ o.label }}</option>
        </select>
      </label>
    </div>
    <!-- 欢迎页：大标志 + 品牌名 + 一句话 + 胶囊「登录 →」 -->
    <div v-if="welcome" class="ao-welcome" data-testid="login-welcome">
      <div class="ao-welcome-mark">
        <img :src="logoUrl" alt="" />
        <b>LULUX ETA</b>
      </div>
      <p class="ao-welcome-line">{{ $t('authx.welcomeLine') }}</p>
      <button
        ref="welcomeButton"
        type="button"
        class="ao-welcome-go"
        data-testid="login-welcome-start"
        @click="startFromWelcome"
      >
        {{ $t('authx.welcomeStart') }}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </div>
    <div v-else class="ao-stage">
      <div class="ao-box">
        <div class="ao-brand">
          <img :src="logoUrl" alt="" />
          <b>LULUX ETA</b>
          <span>{{ $t('authx.tagline') }}</span>
        </div>

        <div class="ao-seg" role="tablist" :aria-label="$t('authx.tabsLabel')">
          <button
            type="button"
            role="tab"
            data-testid="login-tab-local"
            :class="{ on: tab === 'local' }"
            :aria-selected="tab === 'local'"
            @click="pickTab('local')"
          >
            {{ $t('authx.tabLocal') }}</button
          ><button
            type="button"
            role="tab"
            data-testid="login-tab-server"
            :class="{ on: tab === 'server' }"
            :aria-selected="tab === 'server'"
            @click="pickTab('server')"
          >
            {{ $t('authx.tabServer') }}
          </button>
        </div>

        <!-- 本机：登录 -->
        <form
          v-if="tab === 'local' && localView === 'login'"
          class="ao-form"
          data-testid="local-login-form"
          novalidate
          @submit.prevent="submitLocal"
        >
          <label class="ao-field">
            <span>{{ $t('authx.username') }}</span>
            <input
              v-model="local.username"
              type="text"
              name="username"
              autocomplete="username"
              spellcheck="false"
              autocapitalize="off"
              maxlength="32"
              :placeholder="$t('authx.usernamePlaceholder')"
              :disabled="localUnavailable"
              :class="{ invalid: localErrors.username }"
              :aria-invalid="Boolean(localErrors.username)"
              aria-describedby="ao-local-username-error"
              @input="localErrors.username = ''"
            />
          </label>
          <p v-if="localErrors.username" id="ao-local-username-error" class="ao-error" role="alert">
            {{ localErrors.username }}
          </p>
          <label class="ao-field">
            <span>{{ $t('authx.password') }}</span>
            <input
              ref="localPasswordInput"
              v-model="local.password"
              type="password"
              name="local-password"
              autocomplete="current-password"
              maxlength="128"
              :placeholder="$t('authx.passwordPlaceholder')"
              :disabled="localUnavailable"
              :class="{ invalid: localErrors.password }"
              :aria-invalid="Boolean(localErrors.password)"
              aria-describedby="ao-local-password-error"
              @input="localErrors.password = ''"
            />
          </label>
          <p v-if="localErrors.password" id="ao-local-password-error" class="ao-error" role="alert">
            {{ localErrors.password }}
          </p>
          <div v-if="!localUnavailable" class="ao-forgot-row">
            <button type="button" class="ao-link" data-testid="local-forgot" :disabled="localBusy" @click="openForgot">
              {{ $t('authx.forgotPassword') }}
            </button>
          </div>
          <p v-if="localDirect && !hasLocalAccount" class="ao-note" data-testid="local-no-account">
            {{ $t('authx.localNoAccountYet') }}
          </p>
          <p v-if="localUnavailable" class="ao-note" data-testid="local-unavailable">
            {{ $t('authx.localUnavailable') }}
          </p>

          <label class="ao-check">
            <input v-model="remember" type="checkbox" class="sr-only" />
            <span class="ao-box-sq" :class="{ on: remember }" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></svg
            ></span>
            {{ $t('authx.rememberMachine') }}
          </label>

          <p v-if="localErrors.form" class="ao-error ao-form-error" role="alert">{{ localErrors.form }}</p>
          <button class="ao-primary" type="submit" data-testid="local-enter" :disabled="localUnavailable || localBusy">
            {{ localBusy ? $t('authx.signingIn') : $t('authx.signIn') }}
          </button>
          <button
            class="ao-alt"
            type="button"
            data-testid="local-create"
            :disabled="localUnavailable || localBusy"
            @click="pickLocalView('create')"
          >
            {{ $t('authx.createLocal') }}
          </button>

          <div class="ao-foot">
            {{ $t('authx.localFoot') }} ·
            <button type="button" class="ao-link" :aria-expanded="learnOpen" @click="learnOpen = !learnOpen">
              {{ $t('authx.localLearn') }}
            </button>
          </div>
          <div class="ao-hint">{{ $t('authx.localHint') }}</div>
          <div v-if="learnOpen" class="ao-hint ao-more" data-testid="local-learn">{{ $t('authx.localLearnMore') }}</div>
        </form>

        <!-- 本机：忘记密码（恢复码；或数据目录里的重置文件） -->
        <form
          v-else-if="tab === 'local' && localView === 'forgot'"
          class="ao-form"
          data-testid="local-forgot-form"
          novalidate
          @submit.prevent="submitForgot"
        >
          <p class="ao-lead">{{ fileReset ? $t('authx.resetFileLead') : $t('authx.recoverLead') }}</p>
          <label class="ao-field">
            <span>{{ $t('authx.username') }}</span>
            <input
              v-model="local.username"
              type="text"
              name="username"
              autocomplete="username"
              spellcheck="false"
              autocapitalize="off"
              maxlength="32"
              :placeholder="$t('authx.usernamePlaceholder')"
              :class="{ invalid: localErrors.username }"
              :aria-invalid="Boolean(localErrors.username)"
              aria-describedby="ao-forgot-username-error"
              @input="localErrors.username = ''"
            />
          </label>
          <p v-if="localErrors.username" id="ao-forgot-username-error" class="ao-error" role="alert">
            {{ localErrors.username }}
          </p>
          <template v-if="!fileReset">
            <label class="ao-field">
              <span>{{ $t('authx.recoveryCode') }}</span>
              <input
                v-model="local.recoveryCode"
                type="text"
                name="recovery-code"
                autocomplete="one-time-code"
                spellcheck="false"
                autocapitalize="characters"
                maxlength="40"
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                :class="{ invalid: localErrors.recoveryCode }"
                :aria-invalid="Boolean(localErrors.recoveryCode)"
                aria-describedby="ao-forgot-code-error"
                @input="localErrors.recoveryCode = ''"
              />
            </label>
            <p v-if="localErrors.recoveryCode" id="ao-forgot-code-error" class="ao-error" role="alert">
              {{ localErrors.recoveryCode }}
            </p>
          </template>
          <label class="ao-field">
            <span>{{ $t('authx.newPassword') }}</span>
            <input
              v-model="local.password"
              type="password"
              name="new-password"
              autocomplete="new-password"
              maxlength="128"
              :placeholder="$t('authx.newPasswordPlaceholder')"
              :class="{ invalid: localErrors.password }"
              :aria-invalid="Boolean(localErrors.password)"
              aria-describedby="ao-forgot-password-error"
              @input="localErrors.password = ''"
            />
          </label>
          <p v-if="localErrors.password" id="ao-forgot-password-error" class="ao-error" role="alert">
            {{ localErrors.password }}
          </p>
          <label class="ao-field">
            <span>{{ $t('authx.confirmPassword') }}</span>
            <input
              v-model="local.confirm"
              type="password"
              name="confirm-password"
              autocomplete="new-password"
              maxlength="128"
              :placeholder="$t('authx.confirmPlaceholder')"
              :class="{ invalid: localErrors.confirm }"
              :aria-invalid="Boolean(localErrors.confirm)"
              aria-describedby="ao-forgot-confirm-error"
              @input="localErrors.confirm = ''"
            />
          </label>
          <p v-if="localErrors.confirm" id="ao-forgot-confirm-error" class="ao-error" role="alert">
            {{ localErrors.confirm }}
          </p>
          <p v-if="fileReset" class="ao-note" data-testid="local-reset-file-found">{{ $t('authx.resetFileFound') }}</p>

          <p v-if="localErrors.form" class="ao-error ao-form-error" role="alert">{{ localErrors.form }}</p>
          <button class="ao-primary" type="submit" data-testid="local-forgot-submit" :disabled="localBusy">
            {{ localBusy ? $t('authx.resetting') : $t('authx.resetSubmit') }}
          </button>
          <button
            class="ao-alt"
            type="button"
            data-testid="local-back"
            :disabled="localBusy"
            @click="pickLocalView('login')"
          >
            {{ $t('authx.backToLoginPlain') }}
          </button>

          <template v-if="!fileReset">
            <div class="ao-foot">
              <button
                type="button"
                class="ao-link"
                data-testid="local-lost-code"
                :aria-expanded="lostCodeOpen"
                @click="lostCodeOpen = !lostCodeOpen"
              >
                {{ $t('authx.lostCode') }}
              </button>
            </div>
            <div v-if="lostCodeOpen" class="ao-hint ao-more" data-testid="local-lost-code-help">
              <p>{{ $t('authx.lostCodeHelp', [recoveryInfo?.resetFileName ?? 'RESET-LOCAL-PASSWORD']) }}</p>
              <p v-if="recoveryInfo" class="ao-path">
                <code data-testid="local-data-dir">{{ recoveryInfo.dataDir }}</code>
                <button type="button" class="ao-link" data-testid="local-copy-dir" @click="copyDataDir">
                  {{ pathCopied ? $t('authx.pathCopied') : $t('authx.copyPath') }}
                </button>
              </p>
              <p v-else-if="recoveryInfoError" class="ao-error" role="alert">{{ recoveryInfoError }}</p>
              <p>{{ $t('authx.lostCodeNote') }}</p>
              <button type="button" class="ao-link" data-testid="local-recheck" @click="loadRecoveryInfo">
                {{ $t('authx.recheckResetFile') }}
              </button>
            </div>
          </template>
        </form>

        <!-- 本机：首次使用，创建本机账户（同一版式） -->
        <form
          v-else-if="tab === 'local'"
          class="ao-form"
          data-testid="local-create-form"
          novalidate
          @submit.prevent="submitCreate"
        >
          <label class="ao-field">
            <span>{{ $t('authx.username') }}</span>
            <input
              v-model="local.username"
              type="text"
              name="username"
              autocomplete="username"
              spellcheck="false"
              autocapitalize="off"
              maxlength="32"
              :placeholder="$t('authx.usernamePlaceholder')"
              :disabled="localUnavailable"
              :class="{ invalid: localErrors.username }"
              :aria-invalid="Boolean(localErrors.username)"
              aria-describedby="ao-create-username-error"
              @input="localErrors.username = ''"
            />
          </label>
          <p v-if="localErrors.username" id="ao-create-username-error" class="ao-error" role="alert">
            {{ localErrors.username }}
          </p>
          <label class="ao-field">
            <span>{{ $t('authx.password') }}</span>
            <input
              v-model="local.password"
              type="password"
              name="new-password"
              autocomplete="new-password"
              maxlength="128"
              :placeholder="$t('authx.newPasswordPlaceholder')"
              :disabled="localUnavailable"
              :class="{ invalid: localErrors.password }"
              :aria-invalid="Boolean(localErrors.password)"
              aria-describedby="ao-create-password-error"
              @input="localErrors.password = ''"
            />
          </label>
          <p v-if="localErrors.password" id="ao-create-password-error" class="ao-error" role="alert">
            {{ localErrors.password }}
          </p>
          <label class="ao-field">
            <span>{{ $t('authx.confirmPassword') }}</span>
            <input
              v-model="local.confirm"
              type="password"
              name="confirm-password"
              autocomplete="new-password"
              maxlength="128"
              :placeholder="$t('authx.confirmPlaceholder')"
              :disabled="localUnavailable"
              :class="{ invalid: localErrors.confirm }"
              :aria-invalid="Boolean(localErrors.confirm)"
              aria-describedby="ao-create-confirm-error"
              @input="localErrors.confirm = ''"
            />
          </label>
          <p v-if="localErrors.confirm" id="ao-create-confirm-error" class="ao-error" role="alert">
            {{ localErrors.confirm }}
          </p>
          <p v-if="needsAccount" class="ao-note" data-testid="local-first-run">
            {{ $t('authx.localNoAccountYet') }}
          </p>

          <label class="ao-check">
            <input v-model="remember" type="checkbox" class="sr-only" />
            <span class="ao-box-sq" :class="{ on: remember }" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></svg
            ></span>
            {{ $t('authx.rememberMachine') }}
          </label>

          <p v-if="localErrors.form" class="ao-error ao-form-error" role="alert">{{ localErrors.form }}</p>
          <button
            class="ao-primary"
            type="submit"
            data-testid="local-create-submit"
            :disabled="localUnavailable || localBusy"
          >
            {{ localBusy ? $t('authx.creating') : $t('authx.createSubmit') }}
          </button>
          <button
            v-if="!needsAccount"
            class="ao-alt"
            type="button"
            data-testid="local-back"
            :disabled="localBusy"
            @click="pickLocalView('login')"
          >
            {{ $t('authx.backToLogin') }}
          </button>

          <div class="ao-foot">{{ $t('authx.localFoot') }}</div>
          <div class="ao-hint">{{ $t('authx.createLead') }}</div>
        </form>

        <!-- 连接服务器：初始化所有者 -->
        <form v-else-if="showSetup" class="ao-form" novalidate @submit.prevent="submitSetup">
          <h1>{{ $t('login.k1ae0a0k') }}</h1>
          <p class="ao-lead">{{ $t('login.k4wtmpw') }}<code>SETUP TOKEN</code>{{ $t('login.k1jke887') }}</p>
          <label class="ao-field">
            <span>{{ $t('login.kdv9uqs') }}</span>
            <input v-model="setup.setupToken" class="code" autocomplete="off" required />
          </label>
          <label class="ao-field">
            <span>{{ $t('login.ku0fhaj') }}</span>
            <input v-model="setup.orgName" :placeholder="$t('login.khipj6l')" required />
          </label>
          <label class="ao-field">
            <span>{{ $t('login.k1xpx6a0') }}</span>
            <input v-model="setup.name" required />
          </label>
          <label class="ao-field">
            <span>{{ $t('login.k182knuk') }}</span>
            <input v-model="setup.email" type="email" autocomplete="username" placeholder="you@company.com" required />
          </label>
          <label class="ao-field">
            <span>{{ $t('login.k1jjzsan') }}</span>
            <input
              v-model="setup.password"
              type="password"
              autocomplete="new-password"
              aria-describedby="ao-pwd-hint"
              required
            />
          </label>
          <span id="ao-pwd-hint" class="ao-field-hint">{{ $t('login.k1711zwi') }}</span>
          <p v-if="setupError" class="ao-error" role="alert">{{ setupError }}</p>
          <button class="ao-primary" type="submit" :disabled="busy">
            {{ busy ? $t('login.k1w9441s') : $t('login.k14je8ka') }}
          </button>
          <button class="ao-alt" type="button" @click="setupDismissed = true">{{ $t('authx.otherServer') }}</button>
        </form>

        <!-- 连接服务器：登录 -->
        <form v-else class="ao-form" novalidate @submit.prevent="submitServer">
          <label class="ao-field">
            <span>{{ $t('authx.serverUrl') }}</span>
            <input
              v-model="server.url"
              type="url"
              name="server"
              list="ao-recent-servers"
              placeholder="https://eta.your-company.com"
              spellcheck="false"
              autocomplete="url"
              :class="{ invalid: errors.url }"
              :aria-invalid="Boolean(errors.url)"
              aria-describedby="ao-url-error"
              @input="errors.url = ''"
            />
            <datalist id="ao-recent-servers">
              <option v-for="r in recents" :key="r" :value="r" />
            </datalist>
          </label>
          <p v-if="errors.url" id="ao-url-error" class="ao-error" role="alert">{{ errors.url }}</p>
          <label class="ao-field">
            <span>{{ $t('authx.email') }}</span>
            <input
              v-model="server.email"
              type="email"
              name="email"
              placeholder="you@company.com"
              spellcheck="false"
              autocomplete="username"
              :class="{ invalid: errors.email }"
              :aria-invalid="Boolean(errors.email)"
              aria-describedby="ao-email-error"
              @input="errors.email = ''"
            />
          </label>
          <p v-if="errors.email" id="ao-email-error" class="ao-error" role="alert">{{ errors.email }}</p>
          <label class="ao-field">
            <span>{{ $t('authx.password') }}</span>
            <input
              ref="passwordInput"
              v-model="server.password"
              type="password"
              name="password"
              autocomplete="current-password"
              :placeholder="$t('authx.passwordPlaceholder')"
              :class="{ invalid: errors.password }"
              :aria-invalid="Boolean(errors.password)"
              aria-describedby="ao-password-error"
              @input="errors.password = ''"
            />
          </label>
          <p v-if="errors.password" id="ao-password-error" class="ao-error" role="alert">{{ errors.password }}</p>
          <p v-if="notice" class="ao-note" role="status">{{ notice }}</p>

          <label class="ao-check">
            <input v-model="remember" type="checkbox" class="sr-only" />
            <span class="ao-box-sq" :class="{ on: remember }" aria-hidden="true"
              ><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" /></svg
            ></span>
            {{ $t('authx.rememberServer') }}
          </label>

          <p v-if="errors.form" class="ao-error ao-form-error" role="alert">{{ errors.form }}</p>
          <p
            v-if="compatNote"
            :class="compatBlocked ? 'ao-error ao-form-error' : 'ao-note'"
            :role="compatBlocked ? 'alert' : 'status'"
            data-testid="server-version-note"
          >
            {{ compatNote }}
          </p>
          <button class="ao-primary" type="submit" :disabled="busy">
            {{ busy ? $t('authx.signingIn') : $t('authx.signIn') }}
          </button>
          <button class="ao-alt" type="button" data-testid="server-test" :disabled="testing" @click="testConnection">
            {{ testing ? $t('authx.testing') : $t('authx.testConnection') }}
          </button>
          <p v-if="testResult" class="ao-ok" role="status" data-testid="server-test-result">{{ testResult }}</p>

          <div class="ao-foot">{{ $t('authx.serverFoot') }}</div>
          <div class="ao-hint">{{ $t('authx.serverHint') }}</div>
        </form>
      </div>
    </div>
    <RecoveryCodeDialog
      v-if="issuedCode"
      :code="issuedCode.code"
      :reason="issuedCode.reason"
      @done="recoveryCodeSaved"
    />
  </main>
</template>
