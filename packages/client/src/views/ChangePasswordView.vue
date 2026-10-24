<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import logoUrl from '../assets/lulux-neutral.png'
import '../styles/auth-orig.css'
import { auth, initAuth, signOut } from '../lib/session'
import { errorText } from '../stores/ui'
import { t } from '../i18n'

/**
 * 首次登录 / 管理员重置密码后的强制改密：管理员知道这个临时密码，改成只有自己知道的密码后才能进入。
 * 服务端在改密前拒绝其它接口（403 PASSWORD_CHANGE_REQUIRED），这里是唯一能去的页面（另有退出登录）。
 */
const router = useRouter()
const route = useRoute()
const form = reactive({ current: '', next: '', confirm: '' })
const errors = reactive({ current: '', next: '', confirm: '', form: '' })
const busy = ref(false)

function redirectTarget(): string {
  const value = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return value.startsWith('/change-password') ? '/' : value
}

async function submit(): Promise<void> {
  errors.current = errors.next = errors.confirm = errors.form = ''
  if (!form.current) errors.current = t('changePassword.currentRequired')
  if (form.next.length < 8) errors.next = t('changePassword.tooShort')
  else if (form.next === form.current) errors.next = t('changePassword.sameAsTemp')
  if (!errors.next && form.next !== form.confirm) errors.confirm = t('changePassword.mismatch')
  if (errors.current || errors.next || errors.confirm || busy.value) return
  busy.value = true
  try {
    await api.changePassword(form.current, form.next)
    if (auth.me) auth.me.user.mustChangePassword = false
    await initAuth(true)
    await router.replace(redirectTarget())
  } catch (error) {
    if (error instanceof api.ApiError && error.code === 'PASSWORD_INCORRECT')
      errors.current = t('changePassword.incorrect')
    else if (error instanceof api.ApiError && error.code === 'WEAK_PASSWORD') errors.next = t('changePassword.weak')
    else errors.form = errorText(error)
  } finally {
    busy.value = false
  }
}

async function logout(): Promise<void> {
  await signOut()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <main class="auth-orig ao-page" data-testid="change-password-page">
    <div class="ao-topbar"></div>
    <div class="ao-stage">
      <form class="ao-box ao-form" novalidate @submit.prevent="submit">
        <div class="ao-brand">
          <img :src="logoUrl" alt="" />
          <b>LULUX ETA</b>
          <span>{{ $t('authx.tagline') }}</span>
        </div>
        <h1>{{ $t('changePassword.title') }}</h1>
        <p class="ao-lead">{{ $t('changePassword.lead', [auth.me?.user.email ?? '']) }}</p>
        <label class="ao-field">
          <span>{{ $t('changePassword.current') }}</span>
          <input
            v-model="form.current"
            type="password"
            name="current-password"
            autocomplete="current-password"
            maxlength="128"
            autofocus
            :class="{ invalid: errors.current }"
            :aria-invalid="Boolean(errors.current)"
            @input="errors.current = ''"
          />
        </label>
        <p v-if="errors.current" class="ao-error" role="alert">{{ errors.current }}</p>
        <label class="ao-field">
          <span>{{ $t('changePassword.next') }}</span>
          <input
            v-model="form.next"
            type="password"
            name="new-password"
            autocomplete="new-password"
            maxlength="128"
            :class="{ invalid: errors.next }"
            :aria-invalid="Boolean(errors.next)"
            @input="errors.next = ''"
          />
        </label>
        <p v-if="errors.next" class="ao-error" role="alert">{{ errors.next }}</p>
        <label class="ao-field">
          <span>{{ $t('changePassword.confirm') }}</span>
          <input
            v-model="form.confirm"
            type="password"
            name="confirm-password"
            autocomplete="new-password"
            maxlength="128"
            :class="{ invalid: errors.confirm }"
            :aria-invalid="Boolean(errors.confirm)"
            @input="errors.confirm = ''"
          />
        </label>
        <p v-if="errors.confirm" class="ao-error" role="alert">{{ errors.confirm }}</p>
        <p v-if="errors.form" class="ao-error ao-form-error" role="alert">{{ errors.form }}</p>
        <button class="ao-primary" type="submit" :disabled="busy">
          {{ busy ? $t('changePassword.saving') : $t('changePassword.submit') }}
        </button>
        <button class="ao-alt" type="button" data-testid="change-password-logout" @click="logout">
          {{ $t('changePassword.signOut') }}
        </button>
      </form>
    </div>
  </main>
</template>
