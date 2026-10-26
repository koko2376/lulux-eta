<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import logoUrl from '../assets/lulux-neutral.png'
import '../styles/auth-orig.css'
import { verifyLock } from '../api'
import { markUnlocked } from '../lib/lock'
import { errorText } from '../stores/ui'
import { t } from '../i18n'

const router = useRouter()
const route = useRoute()
const pin = ref('')
const error = ref('')
const busy = ref(false)
const attempts = ref(0)

async function submit(): Promise<void> {
  if (!/^\d{4,12}$/.test(pin.value) || busy.value) {
    error.value = t('unlock.kr7uot6')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const { ok } = await verifyLock(pin.value)
    if (!ok) {
      attempts.value++
      error.value = t('unlock.k1wz2iho')
      pin.value = ''
      return
    }
    markUnlocked()
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.replace(redirect)
  } catch (value) {
    error.value = errorText(value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="auth-orig ao-page">
    <div class="ao-topbar"></div>
    <div class="ao-stage">
      <form class="ao-box ao-form" novalidate @submit.prevent="submit">
        <div class="ao-brand">
          <img :src="logoUrl" alt="" />
          <b>LULUX ETA</b>
          <span>{{ $t('authx.tagline') }}</span>
        </div>
        <h1>{{ $t('unlock.klu0hld') }}</h1>
        <p class="ao-lead">{{ $t('unlock.kt2bbsx') }}</p>
        <label class="ao-field">
          <span class="sr-only">PIN</span>
          <input
            v-model="pin"
            class="pin"
            type="password"
            inputmode="numeric"
            autocomplete="current-password"
            maxlength="12"
            :placeholder="$t('unlock.khvi9rb')"
            autofocus
            :class="{ invalid: error }"
            :aria-invalid="Boolean(error)"
            aria-describedby="unlock-error"
          />
        </label>
        <p v-if="error" id="unlock-error" class="ao-error" role="alert">{{ error }}</p>
        <button class="ao-primary" type="submit" :disabled="busy || !pin">
          {{ busy ? $t('unlock.k1641pvc') : $t('unlock.k1tc84af') }}
        </button>
        <p v-if="attempts >= 3" class="ao-hint">{{ $t('unlock.kd0355x') }}</p>
      </form>
    </div>
  </main>
</template>

<style scoped>
.pin {
  text-align: center;
  font-size: 18px !important;
  letter-spacing: 0.3em;
}
.pin::placeholder {
  font-size: 13.5px;
  letter-spacing: normal;
}
</style>
