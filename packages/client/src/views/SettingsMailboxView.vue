<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { relativeTime } from '../lib/labels'
import { emailErrorText, presetForEmail, secretLabel } from '../lib/mail'
import { auth, can, canEditOwned, denyReason } from '../lib/session'
import { openExternal } from '../lib/window'
import { onServerEvent } from '../stores/events'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const presets = ref<api.EmailPreset[]>([])
const accounts = ref<api.EmailAccount[]>([])
const loading = ref(true)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [p, a] = await Promise.all([api.listEmailPresets(), api.listEmailAccounts()])
    presets.value = p
    accounts.value = a
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
  void loadOAuth()
  void loadSettings()
}

let offAccount: (() => void) | null = null
let offSync: (() => void) | null = null
onMounted(() => {
  void load()
  offAccount = onServerEvent('email.account', (data) => {
    const acc = (data as { account: api.EmailAccount }).account
    const i = accounts.value.findIndex((a) => a.id === acc.id)
    if (i >= 0) accounts.value[i] = acc
    else accounts.value.push(acc)
  })
  offSync = onServerEvent('email.sync', (data) => {
    const r = (data as { result: api.SyncResult }).result
    if (r?.newMessages) toast.success(t('settingsMailbox.km8snua', [r.newMessages, r.verdicts.inquiry]))
  })
})
onBeforeUnmount(() => {
  offAccount?.()
  offSync?.()
  stopPoll()
})

const presetName = (id: string | null) => presets.value.find((p) => p.id === id)?.name ?? t('settingsMailbox.k1ijj6oe')
const STATE_LABEL: Record<api.EmailAccountState, string> = {
  idle: t('settingsMailbox.k1wopsai'),
  syncing: t('settingsMailbox.k1906ho'),
  error: t('settingsMailbox.k1nhgkqe'),
  needs_reauth: t('settingsMailbox.k1acggdm'),
}

/* ── 同步 / 测试 / 删除 ── */
const busyId = ref('')
let pollTimer = 0
function stopPoll(): void {
  window.clearInterval(pollTimer)
  pollTimer = 0
}
function pollWhileSyncing(): void {
  stopPoll()
  pollTimer = window.setInterval(async () => {
    accounts.value = await api.listEmailAccounts({ silent: true }).catch(() => accounts.value)
    if (!accounts.value.some((a) => a.status.state === 'syncing')) stopPoll()
  }, 2000)
}
async function sync(acc: api.EmailAccount): Promise<void> {
  busyId.value = acc.id
  try {
    await api.syncEmailAccount(acc.id, { wait: false })
    acc.status.state = 'syncing'
    toast.info(t('settingsMailbox.k1oolhfx', [acc.email]))
    pollWhileSyncing()
  } finally {
    busyId.value = ''
  }
}
const testResult = ref<{ account: string; result: api.EmailTestResult } | null>(null)
async function test(acc: api.EmailAccount): Promise<void> {
  busyId.value = acc.id
  try {
    testResult.value = { account: acc.email, result: await api.testEmailAccount(acc.id) }
  } catch (error) {
    toast.error(emailErrorText(error))
  } finally {
    busyId.value = ''
  }
}
async function remove(acc: api.EmailAccount): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsMailbox.kg7ksyk', [acc.email]),
    message: t('settingsMailbox.k1bo89j4'),
    confirmText: t('settingsMailbox.k14lughy'),
    danger: true,
  })
  if (!ok) return
  await api.deleteEmailAccount(acc.id)
  accounts.value = accounts.value.filter((a) => a.id !== acc.id)
  toast.success(t('settingsMailbox.k1xqwrmq'))
}

/* ── 新建 / 编辑 ── */
const showForm = ref(false)
const editing = ref<api.EmailAccount | null>(null)
const authMode = ref<'password' | 'oauth2'>('password')
const form = reactive({
  email: '',
  displayName: '',
  presetId: 'custom' as string,
  password: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  username: '',
  syncDays: 30,
  syncEnabled: true,
  appendToSent: true,
  signature: '',
  visibility: 'private' as api.Visibility,
})
const formError = ref('')
const formTest = ref<api.EmailTestResult | null>(null)
const saving = ref(false)
const testing = ref(false)
const preset = computed(() => presets.value.find((p) => p.id === form.presetId) ?? null)
const presetTouched = ref(false)

function applyPreset(id: string): void {
  form.presetId = id
  const p = presets.value.find((x) => x.id === id)
  if (!p) return
  if (p.id !== 'custom') {
    Object.assign(form, {
      imapHost: p.imap.host,
      imapPort: p.imap.port,
      imapSecure: p.imap.secure,
      smtpHost: p.smtp.host,
      smtpPort: p.smtp.port,
      smtpSecure: p.smtp.secure,
    })
  }
  form.appendToSent = p.appendToSent
  authMode.value = p.authTypes[0] === 'oauth2' && oauthReady(p) ? 'oauth2' : 'password'
}
function onEmailInput(): void {
  if (editing.value || presetTouched.value) return
  const p = presetForEmail(presets.value, form.email)
  if (p && p.id !== form.presetId) applyPreset(p.id)
}
function onPresetChange(id: string): void {
  presetTouched.value = true
  applyPreset(id)
}

function openCreate(): void {
  editing.value = null
  presetTouched.value = false
  Object.assign(form, {
    email: '',
    displayName: auth.me?.user.name && auth.mode === 'server' ? auth.me.user.name : '',
    password: '',
    username: '',
    syncDays: Number(emailSettings.emailSyncDays) || 30,
    syncEnabled: true,
    signature: '',
    visibility: 'private',
  })
  applyPreset('custom')
  Object.assign(form, { imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 465, imapSecure: true, smtpSecure: true })
  formError.value = ''
  formTest.value = null
  showForm.value = true
}
function openEdit(acc: api.EmailAccount): void {
  editing.value = acc
  presetTouched.value = true
  authMode.value = acc.authType
  Object.assign(form, {
    email: acc.email,
    displayName: acc.displayName,
    presetId: acc.presetId ?? 'custom',
    password: '',
    imapHost: acc.imap.host,
    imapPort: acc.imap.port,
    imapSecure: acc.imap.secure,
    smtpHost: acc.smtp.host,
    smtpPort: acc.smtp.port,
    smtpSecure: acc.smtp.secure,
    username: acc.imap.username === acc.email ? '' : acc.imap.username,
    syncDays: acc.syncDays,
    syncEnabled: acc.syncEnabled,
    appendToSent: acc.appendToSent,
    signature: acc.signature,
    visibility: acc.visibility,
  })
  formError.value = ''
  formTest.value = null
  showForm.value = true
}

function payload(): api.EmailAccountInput {
  const username = form.username.trim() || undefined
  return {
    email: form.email.trim(),
    displayName: form.displayName.trim(),
    presetId: form.presetId === 'custom' ? null : form.presetId,
    imap: { host: form.imapHost.trim(), port: Number(form.imapPort), secure: form.imapSecure, username },
    smtp: { host: form.smtpHost.trim(), port: Number(form.smtpPort), secure: form.smtpSecure, username },
    password: form.password,
    syncDays: Number(form.syncDays) || 30,
    syncEnabled: form.syncEnabled,
    appendToSent: form.appendToSent,
    signature: form.signature,
    ...(auth.mode === 'server' ? { visibility: form.visibility } : {}),
  }
}
function validate(): string {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return t('settingsMailbox.k1788k16')
  if (!form.imapHost.trim() || !form.smtpHost.trim()) return t('settingsMailbox.k126ay48')
  if (!editing.value && !form.password) return t('settingsMailbox.k1o52ex7', [secretLabel(preset.value)])
  return ''
}
async function runTest(): Promise<void> {
  formError.value = validate()
  if (formError.value) return
  testing.value = true
  formTest.value = null
  try {
    formTest.value =
      editing.value && !form.password
        ? await api.testEmailAccount(editing.value.id)
        : await api.testEmailConfig(payload())
  } catch (error) {
    formError.value = emailErrorText(error)
  } finally {
    testing.value = false
  }
}
async function save(): Promise<void> {
  formError.value = validate()
  if (formError.value) return
  saving.value = true
  try {
    const body = payload()
    const saved = editing.value
      ? await api.updateEmailAccount(editing.value.id, { ...body, password: form.password || '' })
      : await api.createEmailAccount({ ...body, verify: true })
    showForm.value = false
    toast.success(editing.value ? t('settingsMailbox.k1yivpj2') : t('settingsMailbox.ktzh39g'))
    await load()
    if (!editing.value) void api.syncEmailAccount(saved.id, { wait: false }).then(pollWhileSyncing)
  } catch (error) {
    formError.value = emailErrorText(error)
  } finally {
    saving.value = false
  }
}

/* ── OAuth ── */
const oauth = ref<api.OAuthConfig | null>(null)
const oauthForm = reactive({ googleId: '', googleSecret: '', msId: '', msTenant: 'common', msSecret: '' })
async function loadOAuth(): Promise<void> {
  try {
    oauth.value = await api.getOAuthConfig()
    Object.assign(oauthForm, {
      googleId: oauth.value.google.clientId,
      msId: oauth.value.microsoft.clientId,
      msTenant: oauth.value.microsoft.tenant || 'common',
      googleSecret: '',
      msSecret: '',
    })
  } catch {
    oauth.value = null
  }
}
function oauthReady(p: api.EmailPreset | null): boolean {
  if (!p?.oauthProvider || !oauth.value) return false
  return Boolean(oauth.value[p.oauthProvider].clientId)
}
async function saveOAuth(): Promise<void> {
  oauth.value = await api.putOAuthConfig({
    google: {
      clientId: oauthForm.googleId.trim(),
      ...(oauthForm.googleSecret ? { clientSecret: oauthForm.googleSecret } : {}),
    },
    microsoft: {
      clientId: oauthForm.msId.trim(),
      tenant: oauthForm.msTenant.trim() || 'common',
      ...(oauthForm.msSecret ? { clientSecret: oauthForm.msSecret } : {}),
    },
  })
  oauthForm.googleSecret = ''
  oauthForm.msSecret = ''
  toast.success(t('settingsMailbox.ksjqtnl'))
}
function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success(t('settingsMailbox.k1r4hxti')))
}

const oauthWaiting = ref<{ state: string; url: string } | null>(null)
let oauthTimer = 0
async function startOAuth(provider: 'google' | 'microsoft', accountId?: string, loginHint?: string): Promise<void> {
  formError.value = ''
  try {
    const res = await api.startOAuth({ provider, accountId, loginHint })
    oauthWaiting.value = { state: res.state, url: res.authUrl }
    openExternal(res.authUrl)
    window.clearInterval(oauthTimer)
    oauthTimer = window.setInterval(async () => {
      try {
        const st = await api.getOAuthStatus(res.state)
        if (st.status === 'pending') return
        window.clearInterval(oauthTimer)
        oauthWaiting.value = null
        if (st.status === 'done') {
          toast.success(t('settingsMailbox.k1th7o5q'))
          showForm.value = false
          await load()
          if (st.accountId) void api.syncEmailAccount(st.accountId, { wait: false }).then(pollWhileSyncing)
        } else toast.error(st.error || t('settingsMailbox.k7fhpid'))
      } catch (error) {
        window.clearInterval(oauthTimer)
        oauthWaiting.value = null
        toast.error(emailErrorText(error))
      }
    }, 1500)
  } catch (error) {
    formError.value = emailErrorText(error)
    if (!accountId) toast.error(formError.value)
  }
}
function cancelOAuth(): void {
  window.clearInterval(oauthTimer)
  oauthWaiting.value = null
}
onBeforeUnmount(cancelOAuth)

/* ── 邮箱相关设置 ── */
const emailSettings = reactive<Record<string, string>>({})
const EMAIL_KEYS = [
  'emailSyncDays',
  'emailSyncIntervalMinutes',
  'emailUseIdle',
  'emailModelClassify',
  'emailAutoLinkCustomers',
  'builtinTools',
]
async function loadSettings(): Promise<void> {
  try {
    const all = await api.listSettings()
    for (const k of EMAIL_KEYS) if (k in all) emailSettings[k] = all[k]
  } catch {
    /* 设置读取失败不影响账户管理 */
  }
}
async function setSetting(key: string, value: string): Promise<void> {
  const before = emailSettings[key]
  emailSettings[key] = value
  try {
    const next = await api.updateSettings({ [key]: value })
    if (key in next) emailSettings[key] = next[key]
  } catch {
    emailSettings[key] = before
  }
}
const canSettings = computed(() => can('settings:write'))
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsMailbox.k1s375tk')" :sub="$t('settingsMailbox.k45zutz')">
      <button
        type="button"
        class="kbtn primary"
        :disabled="!can('data:write')"
        :title="can('data:write') ? '' : denyReason('data:write')"
        @click="openCreate"
      >
        {{ $t('settingsMailbox.k5qi3rz') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsMailbox.k160ed5q') }}</h2>
              <div class="panel-sub">
                {{
                  $t('settingsMailbox.k1ahkqtb', [
                    auth.mode === 'server' ? $t('settingsMailbox.k6c73d2') : $t('settingsMailbox.k12negyn'),
                  ])
                }}
              </div>
            </div>
          </div>
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!accounts.length"
            state="empty"
            :title="$t('settingsMailbox.k1squazo')"
            :message="$t('settingsMailbox.k1b14mxl')"
            compact
          >
            <button v-if="can('data:write')" type="button" class="kbtn primary" @click="openCreate">
              {{ $t('settingsMailbox.k5qi3rz') }}
            </button>
          </StateBlock>
          <div v-else>
            <div v-for="acc in accounts" :key="acc.id" class="row-item" data-testid="mail-account-row">
              <div class="grow">
                <div class="t">
                  {{ acc.email }}
                  <span class="tag">{{ presetName(acc.presetId) }}</span>
                  <span class="tag">{{ acc.authType === 'oauth2' ? 'OAuth' : $t('settingsMailbox.k1mh9vyr') }}</span>
                  <span
                    :class="
                      acc.status.state === 'idle'
                        ? 'badge-on'
                        : acc.status.state === 'syncing'
                          ? 'badge-off'
                          : 'badge-bad'
                    "
                    >{{ STATE_LABEL[acc.status.state] }}</span
                  >
                  <span v-if="auth.mode === 'server'" class="tag">{{ acc.ownerName }}</span>
                </div>
                <div class="d">
                  {{
                    $t('settingsMailbox.kviywsy', [
                      acc.displayName || $t('settingsMailbox.k1euojr3'),
                      acc.status.lastSyncAt ? relativeTime(acc.status.lastSyncAt) : $t('settingsMailbox.k72h7ps'),
                      acc.syncDays,
                      acc.syncEnabled ? $t('settingsMailbox.k1yt3r5v') : $t('settingsMailbox.kt26i4f'),
                    ])
                  }}
                </div>
                <div v-if="acc.secretError" class="d field-error">{{ acc.secretError }}</div>
                <div v-else-if="acc.status.lastError" class="d field-error">{{ acc.status.lastError }}</div>
              </div>
              <div class="panel-actions">
                <button
                  v-if="acc.status.state === 'needs_reauth' && acc.oauthProvider"
                  type="button"
                  class="kbtn sm primary"
                  :disabled="!canEditOwned(acc.ownerId)"
                  @click="startOAuth(acc.oauthProvider, acc.id, acc.email)"
                >
                  {{ $t('settingsMailbox.k8y0eq4') }}
                </button>
                <button
                  type="button"
                  class="kbtn sm"
                  :disabled="busyId === acc.id || acc.status.state === 'syncing'"
                  @click="sync(acc)"
                >
                  {{ acc.status.state === 'syncing' ? $t('settingsMailbox.k14c028q') : $t('settingsMailbox.k1sisn22') }}
                </button>
                <button type="button" class="kbtn sm" :disabled="busyId === acc.id" @click="test(acc)">
                  {{ $t('settingsMailbox.k35iv2t') }}
                </button>
                <button type="button" class="kbtn sm" :disabled="!canEditOwned(acc.ownerId)" @click="openEdit(acc)">
                  {{ $t('settingsMailbox.k1alsnuo') }}
                </button>
                <button
                  type="button"
                  class="kbtn sm danger"
                  :disabled="!canEditOwned(acc.ownerId)"
                  :aria-label="$t('settingsMailbox.k1b4ruiu', [acc.email])"
                  @click="remove(acc)"
                >
                  {{ $t('settingsMailbox.kfcqesv') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsMailbox.k94k6d6') }}</h2>
              <div class="panel-sub">
                {{
                  $t('settingsMailbox.k1dxpztt', [
                    auth.mode === 'server' ? $t('settingsMailbox.kdqoi26') : $t('settingsMailbox.k12negyn'),
                    canSettings ? '' : $t('settingsMailbox.koh7xdj'),
                  ])
                }}
              </div>
            </div>
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.kr192e9') }}</div>
              <div class="d">{{ $t('settingsMailbox.kp98cyu') }}</div>
            </div>
            <select
              class="select"
              style="width: 140px"
              :aria-label="$t('settingsMailbox.kr192e9')"
              :disabled="!canSettings"
              :value="emailSettings.emailSyncIntervalMinutes ?? '5'"
              @change="setSetting('emailSyncIntervalMinutes', ($event.target as HTMLSelectElement).value)"
            >
              <option value="0">{{ $t('settingsMailbox.ktzla4f') }}</option>
              <option value="2">{{ $t('settingsMailbox.k1jtcgun') }}</option>
              <option value="5">{{ $t('settingsMailbox.kmny1zc') }}</option>
              <option value="15">{{ $t('settingsMailbox.kh7rwui') }}</option>
              <option value="60">{{ $t('settingsMailbox.kw6f0af') }}</option>
            </select>
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.k130dkrx') }}</div>
              <div class="d">{{ $t('settingsMailbox.krpnqvm') }}</div>
            </div>
            <input
              class="input"
              style="width: 100px"
              type="number"
              min="1"
              max="365"
              :aria-label="$t('settingsMailbox.k194hgrm')"
              :disabled="!canSettings"
              :value="emailSettings.emailSyncDays ?? '30'"
              @change="setSetting('emailSyncDays', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.khoxr0r') }}</div>
              <div class="d">{{ $t('settingsMailbox.k1a2ncwe') }}</div>
            </div>
            <UiSwitch
              label="IMAP IDLE"
              :disabled="!canSettings"
              :model-value="emailSettings.emailUseIdle === '1'"
              @update:model-value="setSetting('emailUseIdle', $event ? '1' : '0')"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.kv2pqqu') }}</div>
              <div class="d">{{ $t('settingsMailbox.kqw38qh') }}</div>
            </div>
            <UiSwitch
              :label="$t('settingsMailbox.k6jwsy')"
              :disabled="!canSettings"
              :model-value="emailSettings.emailModelClassify === '1'"
              @update:model-value="setSetting('emailModelClassify', $event ? '1' : '0')"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.k1l9dw3q') }}</div>
              <div class="d">{{ $t('settingsMailbox.k1ikor5r') }}</div>
            </div>
            <UiSwitch
              :label="$t('settingsMailbox.k9xxzmg')"
              :disabled="!canSettings"
              :model-value="emailSettings.emailAutoLinkCustomers !== '0'"
              @update:model-value="setSetting('emailAutoLinkCustomers', $event ? '1' : '0')"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsMailbox.k1tnxblr') }}</div>
              <div class="d">
                {{ $t('settingsMailbox.kswiq2e') }} <b>{{ $t('settingsMailbox.kaanskd') }}</b
                >{{ $t('settingsMailbox.k1abopbn') }}
              </div>
            </div>
            <UiSwitch
              :label="$t('settingsMailbox.k1tnxblr')"
              :disabled="!canSettings"
              :model-value="emailSettings.builtinTools !== '0'"
              @update:model-value="setSetting('builtinTools', $event ? '1' : '0')"
            />
          </div>
        </section>

        <section v-if="oauth" class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">Gmail / Microsoft OAuth</h2>
              <div class="panel-sub">
                {{ $t('settingsMailbox.k9xsma1') }}
              </div>
            </div>
          </div>
          <div class="panel-body stack">
            <div class="form-grid">
              <label class="field"
                ><span class="field-label">Google Client ID</span
                ><input v-model="oauthForm.googleId" class="input code" :disabled="!canSettings"
              /></label>
              <label class="field"
                ><span class="field-label"
                  >Google Client Secret {{ oauth.google.hasClientSecret ? $t('settingsMailbox.kyetmt') : '' }}</span
                ><input
                  v-model="oauthForm.googleSecret"
                  class="input code"
                  type="password"
                  autocomplete="off"
                  :placeholder="oauth.google.hasClientSecret ? $t('settingsMailbox.k13dxq6y') : ''"
                  :disabled="!canSettings"
              /></label>
              <label class="field"
                ><span class="field-label">Microsoft Client ID</span
                ><input v-model="oauthForm.msId" class="input code" :disabled="!canSettings"
              /></label>
              <label class="field"
                ><span class="field-label">Microsoft Tenant</span
                ><input v-model="oauthForm.msTenant" class="input code" placeholder="common" :disabled="!canSettings"
              /></label>
              <label class="field"
                ><span class="field-label">{{
                  $t('settingsMailbox.k14wkcz7', [oauth.microsoft.hasClientSecret ? $t('settingsMailbox.kyetmt') : ''])
                }}</span
                ><input
                  v-model="oauthForm.msSecret"
                  class="input code"
                  type="password"
                  autocomplete="off"
                  :disabled="!canSettings"
              /></label>
            </div>
            <div class="note">
              <div class="stack" style="gap: 4px">
                <div>
                  {{ $t('settingsMailbox.k5kgszf') }}<code class="code">{{ oauth.redirectUris.google }}</code>
                  <button type="button" class="kbtn sm ghost" @click="copy(oauth.redirectUris.google)">
                    {{ $t('settingsMailbox.klvqx34') }}
                  </button>
                </div>
                <div>
                  {{ $t('settingsMailbox.k12bhor') }}<code class="code">{{ oauth.redirectUris.microsoft }}</code>
                  <button type="button" class="kbtn sm ghost" @click="copy(oauth.redirectUris.microsoft)">
                    {{ $t('settingsMailbox.klvqx34') }}
                  </button>
                </div>
              </div>
            </div>
            <details class="field-hint">
              <summary>{{ $t('settingsMailbox.k16otftr') }}</summary>
              <p><b>Google</b>{{ $t('settingsMailbox.k1u33fu8') }}</p>
              <p><b>Microsoft</b>{{ $t('settingsMailbox.k138zmua') }}</p>
            </details>
            <div v-if="canSettings" class="panel-actions">
              <button type="button" class="kbtn primary" @click="saveOAuth">
                {{ $t('settingsMailbox.k1a3d8aj') }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 测试结果 -->
    <UiModal
      v-if="testResult"
      :title="$t('settingsMailbox.kgnwxhx', [testResult.account])"
      :width="460"
      @close="testResult = null"
    >
      <ul class="test-list">
        <li :class="testResult.result.imap.ok ? 'ok' : 'bad'">
          {{
            $t('settingsMailbox.k10gqsvo', [
              testResult.result.imap.ok
                ? $t('settingsMailbox.kbj7at6')
                : testResult.result.imap.error || $t('settingsMailbox.kh9nt60'),
            ])
          }}
        </li>
        <li :class="testResult.result.smtp.ok ? 'ok' : 'bad'">
          {{
            $t('settingsMailbox.k10yp6qe', [
              testResult.result.smtp.ok
                ? $t('settingsMailbox.kbj7at6')
                : testResult.result.smtp.error || $t('settingsMailbox.kh9nt60'),
            ])
          }}
        </li>
      </ul>
      <template #footer>
        <button type="button" class="kbtn primary" @click="testResult = null">
          {{ $t('settingsMailbox.kb2htn0') }}
        </button>
      </template>
    </UiModal>

    <!-- OAuth 等待 -->
    <UiModal v-if="oauthWaiting" :title="$t('settingsMailbox.ktn6lea')" :width="440" @close="cancelOAuth">
      <p class="muted" style="font-size: 13px; line-height: 1.7">
        {{ $t('settingsMailbox.kcond4d') }}
      </p>
      <template #footer>
        <button type="button" class="kbtn" @click="openExternal(oauthWaiting.url)">
          {{ $t('settingsMailbox.k12vakxh') }}
        </button>
        <button type="button" class="kbtn" @click="cancelOAuth">{{ $t('settingsMailbox.kldkknc') }}</button>
      </template>
    </UiModal>

    <!-- 新建 / 编辑 -->
    <UiModal
      v-if="showForm"
      :title="editing ? $t('settingsMailbox.kx9psfj', [editing.email]) : $t('settingsMailbox.k5qi3rz')"
      :subtitle="$t('settingsMailbox.kn3gv18')"
      :width="620"
      @close="showForm = false"
    >
      <form id="mail-form" class="stack" @submit.prevent="save">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ $t('settingsMailbox.k1d6f0me') }}</span>
            <input
              v-model="form.email"
              class="input"
              type="email"
              name="email"
              autocomplete="off"
              placeholder="sales@example.com"
              :disabled="Boolean(editing)"
              autofocus
              @input="onEmailInput"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('settingsMailbox.k1hf2z81') }}</span>
            <select
              class="select"
              name="preset"
              :value="form.presetId"
              @change="onPresetChange(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
        </div>

        <div v-if="preset && preset.authTypes.includes('oauth2') && !editing" class="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="authMode === 'oauth2'"
            :class="{ on: authMode === 'oauth2' }"
            @click="authMode = 'oauth2'"
          >
            {{ $t('settingsMailbox.k1e4g39z') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="authMode === 'password'"
            :class="{ on: authMode === 'password' }"
            @click="authMode = 'password'"
          >
            {{ $t('settingsMailbox.kj1rf1h') }}
          </button>
        </div>

        <template v-if="authMode === 'oauth2' && preset?.oauthProvider && !editing">
          <div class="note">
            <span>
              {{ $t('settingsMailbox.k141azx2', [preset.name]) }}
              <template v-if="!oauthReady(preset)">
                <br /><b>{{
                  $t('settingsMailbox.koqvvci', [preset.oauthProvider === 'google' ? 'Google' : 'Microsoft'])
                }}</b
                >{{ $t('settingsMailbox.kn7e1z5', [canSettings ? '' : $t('settingsMailbox.k1l2d3sg')]) }}
              </template>
            </span>
          </div>
        </template>

        <template v-else>
          <div v-if="preset" class="note">
            <span>
              {{ preset.authHint }}
              <button v-if="preset.helpUrl" type="button" class="kbtn sm ghost" @click="openExternal(preset.helpUrl)">
                {{ $t('settingsMailbox.kdjhr4c') }}
              </button>
            </span>
          </div>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ secretLabel(preset) }}</span>
              <input
                v-model="form.password"
                class="input"
                type="password"
                name="password"
                autocomplete="new-password"
                :placeholder="editing ? $t('settingsMailbox.k13dxq6y') : ''"
              />
            </label>
            <label class="field">
              <span class="field-label">{{ $t('settingsMailbox.k1x8qylj') }}</span>
              <input
                v-model="form.displayName"
                class="input"
                name="displayName"
                :placeholder="$t('settingsMailbox.kdo1yom')"
              />
            </label>
          </div>
          <details :open="form.presetId === 'custom'">
            <summary class="field-label">{{ $t('settingsMailbox.k1k4eht3') }}</summary>
            <div class="form-grid" style="margin-top: 10px">
              <label class="field"
                ><span class="field-label">{{ $t('settingsMailbox.kdykek3') }}</span
                ><input v-model="form.imapHost" class="input" name="imapHost"
              /></label>
              <div class="hstack">
                <label class="field" style="width: 90px"
                  ><span class="field-label">{{ $t('settingsMailbox.ku63gad') }}</span
                  ><input v-model.number="form.imapPort" class="input" type="number" name="imapPort"
                /></label>
                <label class="check" style="margin-top: 18px"
                  ><input v-model="form.imapSecure" type="checkbox" />SSL/TLS</label
                >
              </div>
              <label class="field"
                ><span class="field-label">{{ $t('settingsMailbox.k1532zdx') }}</span
                ><input v-model="form.smtpHost" class="input" name="smtpHost"
              /></label>
              <div class="hstack">
                <label class="field" style="width: 90px"
                  ><span class="field-label">{{ $t('settingsMailbox.ku63gad') }}</span
                  ><input v-model.number="form.smtpPort" class="input" type="number" name="smtpPort"
                /></label>
                <label class="check" style="margin-top: 18px"
                  ><input v-model="form.smtpSecure" type="checkbox" />SSL/TLS</label
                >
              </div>
              <label class="field"
                ><span class="field-label">{{ $t('settingsMailbox.k13dbnkt') }}</span
                ><input v-model="form.username" class="input" name="username" autocomplete="off"
              /></label>
              <label class="field"
                ><span class="field-label">{{ $t('settingsMailbox.k194hgrm') }}</span
                ><input v-model.number="form.syncDays" class="input" type="number" min="1" max="365"
              /></label>
              <label v-if="auth.mode === 'server'" class="field"
                ><span class="field-label">{{ $t('settingsMailbox.kr2943m') }}</span
                ><select v-model="form.visibility" class="select">
                  <option value="private">{{ $t('settingsMailbox.kbbyg21') }}</option>
                  <option value="team">{{ $t('settingsMailbox.k199hf4c') }}</option>
                  <option value="org">{{ $t('settingsMailbox.kdqoi26') }}</option>
                </select></label
              >
              <label class="field span-all"
                ><span class="field-label">{{ $t('settingsMailbox.k1tgy9ci') }}</span
                ><textarea v-model="form.signature" class="textarea" rows="3"></textarea>
              </label>
            </div>
            <div class="hstack" style="margin-top: 10px">
              <label class="check"
                ><input v-model="form.syncEnabled" type="checkbox" />{{ $t('settingsMailbox.kqjl80s') }}</label
              >
              <label class="check"
                ><input v-model="form.appendToSent" type="checkbox" />{{ $t('settingsMailbox.k10pbopr') }}</label
              >
            </div>
          </details>
          <ul v-if="formTest" class="test-list" aria-live="polite">
            <li :class="formTest.imap.ok ? 'ok' : 'bad'">
              {{
                $t('settingsMailbox.k10gqsvo', [
                  formTest.imap.ok
                    ? $t('settingsMailbox.kbj7at6')
                    : formTest.imap.error || $t('settingsMailbox.kh9nt60'),
                ])
              }}
            </li>
            <li :class="formTest.smtp.ok ? 'ok' : 'bad'">
              {{
                $t('settingsMailbox.k10yp6qe', [
                  formTest.smtp.ok
                    ? $t('settingsMailbox.kbj7at6')
                    : formTest.smtp.error || $t('settingsMailbox.kh9nt60'),
                ])
              }}
            </li>
          </ul>
        </template>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('settingsMailbox.kldkknc') }}</button>
        <template v-if="authMode === 'oauth2' && preset?.oauthProvider && !editing">
          <button
            type="button"
            class="kbtn primary"
            :disabled="!oauthReady(preset)"
            @click="startOAuth(preset.oauthProvider, undefined, form.email.trim() || undefined)"
          >
            {{ $t('settingsMailbox.k1lywlo0') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="kbtn" :disabled="testing" @click="runTest">
            {{ testing ? $t('settingsMailbox.kkcjegh') : $t('settingsMailbox.k4mzqwc') }}
          </button>
          <button type="submit" form="mail-form" class="kbtn primary" :disabled="saving">
            {{ saving ? $t('settingsMailbox.kpvojie') : $t('settingsMailbox.k1xlvxln') }}
          </button>
        </template>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.test-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.test-list li {
  padding: 8px 12px;
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.test-list .ok {
  background: var(--good-soft);
  color: var(--good);
}
.test-list .bad {
  background: var(--danger-soft);
  color: var(--danger);
}
/* 折叠标题点击区域 ≥24px（原 18px） */
details > summary {
  cursor: pointer;
  padding-block: 3px;
  width: fit-content;
}
details p {
  margin: 6px 0 0;
}
</style>
