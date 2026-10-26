<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import RecoveryCodeDialog from '../components/RecoveryCodeDialog.vue'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { useRouter } from 'vue-router'
import { formatDate } from '../lib/labels'
import { checkLock, lockState, markUnlocked } from '../lib/lock'
import { ROLE_LABEL, auth, signOut } from '../lib/session'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const router = useRouter()
async function doLogout(): Promise<void> {
  await signOut()
  await router.replace({ name: 'login' })
}

/* 本机账户（desktop 模式直连本机时） */
const showLocalAccount = computed(() => auth.mode !== 'server' && auth.connection === 'local')
const localPwdOpen = ref(false)
const localPwd = reactive({ current: '', next: '', confirm: '' })
const localPwdError = ref('')
async function submitLocalPassword(): Promise<void> {
  localPwdError.value = ''
  if (localPwd.next.length < 8) return void (localPwdError.value = t('settingsAccount.kt7xxzt'))
  if (localPwd.next !== localPwd.confirm) return void (localPwdError.value = t('settingsAccount.k1lwwhpz'))
  pwdSaving.value = true
  try {
    await api.changeLocalPassword(localPwd.current, localPwd.next)
    toast.success(t('settingsAccount.localPwdChanged'))
    localPwdOpen.value = false
    Object.assign(localPwd, { current: '', next: '', confirm: '' })
  } catch (error) {
    localPwdError.value =
      error instanceof api.ApiError && error.code === 'PASSWORD_INCORRECT'
        ? t('settingsAccount.k1d2jsy8')
        : error instanceof api.ApiError && error.code === 'WEAK_PASSWORD'
          ? t('settingsAccount.localWeak')
          : error instanceof api.ApiError && error.code === 'LOGIN_RATE_LIMITED'
            ? t('authx.localRateLimited')
            : errorText(error)
  } finally {
    pwdSaving.value = false
  }
}

/* 本机账户恢复码：凭当前密码重新生成，旧的立即作废；新码只显示一次 */
const recoveryOpen = ref(false)
const recoveryPassword = ref('')
const recoveryError = ref('')
const recoverySaving = ref(false)
const newRecoveryCode = ref('')
function openRecovery(): void {
  recoveryPassword.value = ''
  recoveryError.value = ''
  recoveryOpen.value = true
}
async function submitRecovery(): Promise<void> {
  recoveryError.value = ''
  if (!recoveryPassword.value) return void (recoveryError.value = t('authx.passwordRequired'))
  recoverySaving.value = true
  try {
    const { recoveryCode } = await api.regenerateLocalRecoveryCode(recoveryPassword.value)
    recoveryOpen.value = false
    recoveryPassword.value = ''
    newRecoveryCode.value = recoveryCode
  } catch (error) {
    recoveryError.value =
      error instanceof api.ApiError && error.code === 'PASSWORD_INCORRECT'
        ? t('settingsAccount.k1d2jsy8')
        : error instanceof api.ApiError && error.code === 'LOGIN_RATE_LIMITED'
          ? t('authx.localRateLimited')
          : errorText(error)
  } finally {
    recoverySaving.value = false
  }
}

/* 修改密码（server 模式） */
const pwdOpen = ref(false)
const pwd = reactive({ current: '', next: '', confirm: '' })
const pwdError = ref('')
const pwdSaving = ref(false)
async function submitPassword(): Promise<void> {
  pwdError.value = ''
  if (pwd.next.length < 8) return void (pwdError.value = t('settingsAccount.kt7xxzt'))
  if (pwd.next !== pwd.confirm) return void (pwdError.value = t('settingsAccount.k1lwwhpz'))
  pwdSaving.value = true
  try {
    await api.changePassword(pwd.current, pwd.next)
    toast.success(t('settingsAccount.ks86z9z'))
    pwdOpen.value = false
    Object.assign(pwd, { current: '', next: '', confirm: '' })
  } catch (error) {
    pwdError.value =
      error instanceof api.ApiError && error.code === 'PASSWORD_INCORRECT'
        ? t('settingsAccount.k1d2jsy8')
        : error instanceof api.ApiError && error.code === 'WEAK_PASSWORD'
          ? t('settingsAccount.k1fmpi02')
          : errorText(error)
  } finally {
    pwdSaving.value = false
  }
}

const loading = ref(true)
const loadError = ref('')
const unsupported = ref(false)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.getLock()
    lockState.enabled = Boolean(res.enabled)
    unsupported.value = false
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 404) unsupported.value = true
    else loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

type Mode = 'setup' | 'disable' | 'change'
const mode = ref<Mode | null>(null)
const form = reactive({ current: '', pin: '', confirm: '' })
const formError = ref('')
const saving = ref(false)
const valid = (pin: string) => /^\d{4,12}$/.test(pin)
const title = computed(
  () =>
    ({
      setup: t('settingsAccount.k1v7qkdr'),
      disable: t('settingsAccount.kxlr9if'),
      change: t('settingsAccount.k3yfkro'),
    })[mode.value ?? 'setup'],
)

function open(next: Mode): void {
  mode.value = next
  Object.assign(form, { current: '', pin: '', confirm: '' })
  formError.value = ''
}

function onToggle(on: boolean): void {
  open(on ? 'setup' : 'disable')
}

async function submit(): Promise<void> {
  formError.value = ''
  const m = mode.value
  if (!m) return
  if (m !== 'setup' && !valid(form.current)) return void (formError.value = t('settingsAccount.k1jrtugz'))
  if (m !== 'disable') {
    if (!valid(form.pin)) return void (formError.value = t('settingsAccount.k1rsikol'))
    if (form.pin !== form.confirm) return void (formError.value = t('settingsAccount.k1mt90ti'))
  }
  saving.value = true
  try {
    if (m === 'disable' || m === 'change') {
      await api.disableLock(form.current)
    }
    if (m === 'setup' || m === 'change') {
      await api.setupLock(form.pin)
      markUnlocked()
    }
    await checkLock(true)
    toast.success(
      m === 'disable'
        ? t('settingsAccount.kem6aeq')
        : m === 'change'
          ? t('settingsAccount.k1d83e9c')
          : t('settingsAccount.k1oz2ckg'),
    )
    mode.value = null
  } catch (error) {
    formError.value =
      error instanceof api.ApiError && error.status === 403 ? t('settingsAccount.k1giuke4') : errorText(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar
      :title="auth.mode === 'server' ? $t('settingsAccount.ko9b1kn') : $t('settingsAccount.ko8g941')"
      :sub="auth.mode === 'server' ? $t('settingsAccount.k1qu83b7') : $t('settingsAccount.k14vmike')"
    />
    <div class="doc">
      <div class="doc-inner">
        <section v-if="showLocalAccount" class="panel" data-testid="local-account-panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsAccount.localAccountTitle') }}</h2>
              <div class="panel-sub">{{ $t('settingsAccount.localAccountSub') }}</div>
            </div>
          </div>
          <div v-if="auth.local.hasAccount" class="row-item">
            <div class="grow">
              <div class="t" data-testid="local-username">{{ auth.local.username }}</div>
              <div class="d">{{ $t('settingsAccount.localSignedInAs', [auth.local.username]) }}</div>
            </div>
            <button type="button" class="kbtn sm" data-testid="local-change-password" @click="localPwdOpen = true">
              {{ $t('settingsAccount.k30pgar') }}
            </button>
            <button type="button" class="kbtn sm" data-testid="local-recovery-regenerate" @click="openRecovery">
              {{ $t('settingsAccount.recoveryRegenerate') }}
            </button>
            <button type="button" class="kbtn sm danger" data-testid="logout" @click="doLogout">
              {{ $t('settingsAccount.k2koptg') }}
            </button>
          </div>
          <div v-else class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsAccount.localNoAccount') }}</div>
              <div class="d">{{ $t('settingsAccount.localNoAccountDesc') }}</div>
            </div>
            <RouterLink
              class="kbtn sm"
              data-testid="local-create-link"
              :to="{ path: '/login', query: { create: '1' } }"
              >{{ $t('settingsAccount.localCreate') }}</RouterLink
            >
          </div>
        </section>

        <section v-if="auth.mode !== 'server'" class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsAccount.k111slz9') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsAccount.kkpyyb6') }}
              </div>
            </div>
          </div>
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="unsupported"
            state="empty"
            :title="$t('settingsAccount.k1lrkeaf')"
            :message="$t('settingsAccount.kj5vh52')"
            compact
          />
          <template v-else>
            <div class="row-item">
              <div class="grow">
                <div class="t">
                  {{ $t('settingsAccount.kupw85y') }}
                  <span :class="lockState.enabled ? 'badge-on' : 'badge-off'">{{
                    lockState.enabled ? $t('settingsAccount.k1nt2knb') : $t('settingsAccount.k1fbxban')
                  }}</span>
                </div>
                <div class="d">{{ $t('settingsAccount.k1sye397') }}</div>
              </div>
              <UiSwitch
                :model-value="lockState.enabled"
                :label="$t('settingsAccount.kupw85y')"
                @update:model-value="onToggle"
              />
            </div>
            <div v-if="lockState.enabled" class="row-item">
              <div class="grow">
                <div class="t">{{ $t('settingsAccount.k3yfkro') }}</div>
              </div>
              <button type="button" class="kbtn sm" @click="open('change')">
                {{ $t('settingsAccount.k1jzik2f') }}
              </button>
            </div>
          </template>
        </section>

        <section class="panel" data-testid="session-panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">
                {{ auth.mode === 'server' ? $t('settingsAccount.kdsngzk') : $t('settingsAccount.kdxozb2') }}
              </h2>
              <div class="panel-sub">
                <template v-if="auth.mode === 'server'">
                  {{ $t('settingsAccount.k1861e62', [auth.serverUrl || $t('settingsAccount.k7pecxi')]) }}
                </template>
                <template v-else>
                  {{ $t('settingsAccount.kgjlbc4') }}
                </template>
              </div>
            </div>
            <RouterLink v-if="auth.mode !== 'server'" class="kbtn" to="/login">{{
              $t('settingsAccount.kdxozb2')
            }}</RouterLink>
          </div>
          <template v-if="auth.mode === 'server' && auth.me">
            <div class="row-item">
              <div class="grow">
                <div class="t">
                  {{ auth.me.user.name }} <span class="tag">{{ ROLE_LABEL[auth.me.user.role] }}</span>
                </div>
                <div class="d">
                  {{ auth.me.user.email }} · {{ auth.me.org.name }}
                  <template v-if="auth.me.session">
                    {{ $t('settingsAccount.k7pq7fk', [formatDate(auth.me.session.expiresAt)]) }}</template
                  >
                </div>
              </div>
              <button type="button" class="kbtn sm" @click="pwdOpen = true">{{ $t('settingsAccount.k30pgar') }}</button>
              <button type="button" class="kbtn sm danger" data-testid="logout" @click="doLogout">
                {{ $t('settingsAccount.k2koptg') }}
              </button>
            </div>
            <div class="row-item">
              <div class="grow">
                <div class="t">{{ $t('settingsAccount.k1funy61') }}</div>
                <div class="d">{{ $t('settingsAccount.k1a6z7dm') }}</div>
              </div>
              <RouterLink class="kbtn sm" to="/login">{{ $t('settingsAccount.k16m0x6m') }}</RouterLink>
            </div>
          </template>
        </section>
      </div>
    </div>

    <UiModal v-if="mode" :title="title" :width="420" @close="mode = null">
      <form id="lock-form" class="stack" @submit.prevent="submit">
        <label v-if="mode !== 'setup'" class="field">
          <span class="field-label">{{ $t('settingsAccount.k1tefeen') }}</span>
          <input
            v-model="form.current"
            class="input"
            type="password"
            inputmode="numeric"
            maxlength="12"
            autocomplete="current-password"
            autofocus
          />
        </label>
        <template v-if="mode !== 'disable'">
          <label class="field">
            <span class="field-label">{{ $t('settingsAccount.k1h9fsm7') }}</span>
            <input
              v-model="form.pin"
              class="input"
              type="password"
              inputmode="numeric"
              maxlength="12"
              autocomplete="new-password"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('settingsAccount.k7awyte') }}</span>
            <input
              v-model="form.confirm"
              class="input"
              type="password"
              inputmode="numeric"
              maxlength="12"
              autocomplete="new-password"
            />
          </label>
        </template>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="mode = null">{{ $t('settingsAccount.kldkknc') }}</button>
        <button
          type="submit"
          form="lock-form"
          class="kbtn primary"
          :class="{ danger: mode === 'disable' }"
          :disabled="saving"
        >
          {{
            saving
              ? $t('settingsAccount.k7yezt3')
              : mode === 'disable'
                ? $t('settingsAccount.kxlr9if')
                : $t('settingsAccount.k1xlvxln')
          }}
        </button>
      </template>
    </UiModal>
    <UiModal v-if="localPwdOpen" :title="$t('settingsAccount.k30pgar')" :width="420" @close="localPwdOpen = false">
      <form id="local-pwd-form" class="stack" @submit.prevent="submitLocalPassword">
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.kec4ufj') }}</span
          ><input
            v-model="localPwd.current"
            name="current-password"
            class="input"
            type="password"
            autocomplete="current-password"
            autofocus
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.k1i6zbzf') }}</span
          ><input v-model="localPwd.next" name="new-password" class="input" type="password" autocomplete="new-password"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.k1q7fx46') }}</span
          ><input
            v-model="localPwd.confirm"
            name="confirm-password"
            class="input"
            type="password"
            autocomplete="new-password"
        /></label>
        <p v-if="localPwdError" class="field-error" role="alert">{{ localPwdError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="localPwdOpen = false">{{ $t('settingsAccount.kldkknc') }}</button>
        <button type="submit" form="local-pwd-form" class="kbtn primary" :disabled="pwdSaving">
          {{ $t('settingsAccount.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
    <UiModal
      v-if="recoveryOpen"
      :title="$t('settingsAccount.recoveryRegenerate')"
      :subtitle="$t('settingsAccount.recoveryRegenerateLead')"
      :width="420"
      @close="recoveryOpen = false"
    >
      <form id="local-recovery-form" class="stack" @submit.prevent="submitRecovery">
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.kec4ufj') }}</span
          ><input
            v-model="recoveryPassword"
            name="recovery-current-password"
            class="input"
            type="password"
            autocomplete="current-password"
            autofocus
        /></label>
        <p v-if="recoveryError" class="field-error" role="alert">{{ recoveryError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="recoveryOpen = false">{{ $t('settingsAccount.kldkknc') }}</button>
        <button
          type="submit"
          form="local-recovery-form"
          class="kbtn primary"
          data-testid="local-recovery-submit"
          :disabled="recoverySaving"
        >
          {{ $t('settingsAccount.recoveryRegenerateSubmit') }}
        </button>
      </template>
    </UiModal>
    <RecoveryCodeDialog
      v-if="newRecoveryCode"
      :code="newRecoveryCode"
      reason="regenerated"
      @done="newRecoveryCode = ''"
    />
    <UiModal v-if="pwdOpen" :title="$t('settingsAccount.k30pgar')" :width="420" @close="pwdOpen = false">
      <form id="pwd-form" class="stack" @submit.prevent="submitPassword">
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.kec4ufj') }}</span
          ><input v-model="pwd.current" class="input" type="password" autocomplete="current-password" autofocus
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.k1i6zbzf') }}</span
          ><input v-model="pwd.next" class="input" type="password" autocomplete="new-password"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('settingsAccount.k1q7fx46') }}</span
          ><input v-model="pwd.confirm" class="input" type="password" autocomplete="new-password"
        /></label>
        <p v-if="pwdError" class="field-error" role="alert">{{ pwdError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="pwdOpen = false">{{ $t('settingsAccount.kldkknc') }}</button>
        <button type="submit" form="pwd-form" class="kbtn primary" :disabled="pwdSaving">
          {{ $t('settingsAccount.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>
