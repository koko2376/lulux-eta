<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import logoUrl from '../assets/lulux-neutral.png'
import '../styles/auth-orig.css'
import StateBlock from '../components/ui/StateBlock.vue'
import { formatDate } from '../lib/labels'
import { ROLE_LABEL, saveSession } from '../lib/session'
import { errorText } from '../stores/ui'
import { t } from '../i18n'

const route = useRoute()
const router = useRouter()
const code = ref(typeof route.query.code === 'string' ? route.query.code.trim() : '')
const info = ref<Awaited<ReturnType<typeof api.getInvitePublic>> | null>(null)
const loading = ref(false)
const loadError = ref('')
const form = reactive({ name: '', email: '', password: '' })
const busy = ref(false)
const error = ref('')

const ERRORS: Record<string, string> = {
  INVITE_INVALID: t('join.k1zjn0a'),
  INVITE_EXPIRED: t('join.k102n0vg'),
  INVITE_EMAIL_MISMATCH: t('join.k1mb8ezo'),
  EMAIL_TAKEN: t('join.k1jicvde'),
  WEAK_PASSWORD: t('join.kr05pd5'),
  LOGIN_RATE_LIMITED: t('join.k1cx3kk2'),
}
const describe = (e: unknown) => (e instanceof api.ApiError ? (ERRORS[e.code] ?? e.message) : errorText(e))

async function lookup(): Promise<void> {
  if (!code.value) return
  loading.value = true
  loadError.value = ''
  info.value = null
  try {
    info.value = await api.getInvitePublic(code.value)
    if (info.value.email) form.email = info.value.email
  } catch (e) {
    loadError.value = describe(e)
  } finally {
    loading.value = false
  }
}
onMounted(lookup)

async function submit(): Promise<void> {
  error.value = ''
  if (!form.name.trim() || !form.email.trim() || !form.password) return void (error.value = t('join.kfqwi8k'))
  busy.value = true
  try {
    await saveSession(await api.acceptInvite({ code: code.value, ...form, email: form.email.trim() }))
    await router.replace('/')
  } catch (e) {
    error.value = describe(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="auth-orig ao-page">
    <div class="ao-topbar"></div>
    <div class="ao-stage">
      <div class="ao-box">
        <div class="ao-brand">
          <img :src="logoUrl" alt="" />
          <b>LULUX ETA</b>
          <span>{{ $t('authx.tagline') }}</span>
        </div>
        <form v-if="!info" class="ao-form" novalidate @submit.prevent="lookup">
          <h1>{{ $t('join.k1l79odk') }}</h1>
          <label class="ao-field">
            <span>{{ $t('join.k1auzvyl') }}</span>
            <input
              v-model="code"
              class="code"
              placeholder="lxi_…"
              autocomplete="off"
              :class="{ invalid: loadError }"
              :aria-invalid="Boolean(loadError)"
            />
          </label>
          <StateBlock v-if="loading" state="loading" compact />
          <p v-if="loadError" class="ao-error" role="alert">{{ loadError }}</p>
          <button class="ao-primary" type="submit" :disabled="!code || loading">{{ $t('join.kntdx1g') }}</button>
          <RouterLink class="ao-alt" to="/login">{{ $t('join.k17wan4i') }}</RouterLink>
        </form>
        <form v-else class="ao-form" novalidate @submit.prevent="submit">
          <h1>{{ $t('join.k1l79odk') }}</h1>
          <p class="ao-lead" data-testid="invite-info">
            {{ $t('join.kzsfqht') }} <b>{{ info.orgName }}</b
            >{{ $t('join.kl6q585') }}<b>{{ ROLE_LABEL[info.role] }}</b
            >{{ $t('join.k148yo0c', [formatDate(info.expiresAt)]) }}
          </p>
          <label class="ao-field">
            <span>{{ $t('join.k1xpx6a0') }}</span>
            <input v-model="form.name" name="name" autocomplete="name" required />
          </label>
          <label class="ao-field">
            <span>{{ $t('join.k182knuk') }}</span>
            <input
              v-model="form.email"
              type="email"
              name="email"
              placeholder="you@company.com"
              autocomplete="username"
              :readonly="Boolean(info.email)"
              required
            />
          </label>
          <label class="ao-field">
            <span>{{ $t('join.kf2grv9') }}</span>
            <input
              v-model="form.password"
              type="password"
              name="password"
              autocomplete="new-password"
              aria-describedby="ao-join-pwd-hint"
              required
            />
          </label>
          <span id="ao-join-pwd-hint" class="ao-field-hint">{{ $t('join.k1711zwi') }}</span>
          <p v-if="error" class="ao-error" role="alert">{{ error }}</p>
          <button class="ao-primary" type="submit" :disabled="busy">
            {{ busy ? $t('join.k1pvxok7') : $t('join.krome3m') }}
          </button>
          <RouterLink class="ao-alt" to="/login">{{ $t('join.k17wan4i') }}</RouterLink>
        </form>
      </div>
    </div>
  </main>
</template>
