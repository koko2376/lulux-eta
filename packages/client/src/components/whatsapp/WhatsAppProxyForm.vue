<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import * as api from '../../api'
import StateBlock from '../ui/StateBlock.vue'
import { errorText, toast } from '../../stores/ui'
import { t } from '../../i18n'

/**
 * 本机关联的 WhatsApp 账号的出口代理（单个）。团队服务器上由绑定者或老板 / 管理员设置。
 * 密码不回显：留空保存 = 保留原密码；勾“清除密码”才清掉。
 */
const emit = defineEmits<{ saved: [proxy: api.WhatsAppProxy | null] }>()

const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const testing = ref(false)
const current = ref<api.WhatsAppProxy | null>(null)
const result = ref<api.WhatsAppProxyTest | null>(null)
const form = reactive({ protocol: 'socks5' as api.WhatsAppProxyProtocol, host: '', port: 1080, username: '', password: '', clearPassword: false })

function fill(p: api.WhatsAppProxy | null): void {
  current.value = p
  form.protocol = p?.protocol ?? 'socks5'
  form.host = p?.host ?? ''
  form.port = p?.port ?? 1080
  form.username = p?.username ?? ''
  form.password = ''
  form.clearPassword = false
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    fill((await api.getWhatsAppProxy()).proxy)
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

function input(): api.WhatsAppProxyInput {
  const out: api.WhatsAppProxyInput = { protocol: form.protocol, host: form.host.trim(), port: Number(form.port), username: form.username.trim() }
  if (form.password) out.password = form.password
  else if (form.clearPassword) out.password = ''
  return out
}

const valid = (): boolean => Boolean(form.host.trim()) && Number.isInteger(Number(form.port)) && Number(form.port) >= 1 && Number(form.port) <= 65535

async function save(): Promise<void> {
  if (!valid()) {
    toast.error(t('waProxy.invalid'))
    return
  }
  saving.value = true
  try {
    const res = await api.saveWhatsAppProxy(input())
    fill(res.proxy)
    toast.success(res.reconnected ? t('waProxy.savedReconnect') : t('waProxy.saved'))
    emit('saved', res.proxy)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    saving.value = false
  }
}

async function clear(): Promise<void> {
  saving.value = true
  try {
    const res = await api.clearWhatsAppProxy()
    fill(null)
    result.value = null
    toast.success(res.reconnected ? t('waProxy.clearedReconnect') : t('waProxy.cleared'))
    emit('saved', null)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  if (!valid()) {
    toast.error(t('waProxy.invalid'))
    return
  }
  testing.value = true
  result.value = null
  try {
    result.value = await api.testWhatsAppProxy(input())
  } catch (error) {
    result.value = { ok: false, error: errorText(error) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="stack" data-testid="wa-proxy-form">
    <StateBlock v-if="loading" state="loading" compact />
    <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
    <template v-else>
      <p class="field-hint">{{ $t('waProxy.hint') }}</p>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ $t('waProxy.protocol') }}</span>
          <select v-model="form.protocol" class="select" name="protocol">
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('waProxy.port') }}</span>
          <input v-model.number="form.port" class="input" type="number" min="1" max="65535" name="port" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">{{ $t('waProxy.host') }}</span>
        <input v-model="form.host" class="input" name="host" autocomplete="off" :placeholder="$t('waProxy.hostPlaceholder')" />
      </label>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ $t('waProxy.username') }}</span>
          <input v-model="form.username" class="input" name="username" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('waProxy.password') }}</span>
          <input
            v-model="form.password"
            class="input"
            type="password"
            name="password"
            autocomplete="new-password"
            :placeholder="current?.hasPassword ? $t('waProxy.passwordKept') : ''"
          />
        </label>
      </div>
      <label v-if="current?.hasPassword && !form.password" class="check">
        <input v-model="form.clearPassword" type="checkbox" />
        <span>{{ $t('waProxy.clearPassword') }}</span>
      </label>

      <div v-if="result" class="note" :class="{ warn: !result.ok }" role="status" data-testid="wa-proxy-result">
        <template v-if="result.ok">
          {{ $t('waProxy.testOk', [result.ip ?? '-', [result.country, result.city].filter(Boolean).join(' · ') || '-', result.latencyMs ?? 0]) }}
        </template>
        <template v-else>{{ $t('waProxy.testFail', [result.error ?? '']) }}</template>
      </div>

      <div class="panel-actions">
        <button v-if="current" type="button" class="kbtn danger" :disabled="saving" @click="clear">{{ $t('waProxy.clear') }}</button>
        <span class="grow" />
        <button type="button" class="kbtn" :disabled="testing || saving" @click="test">
          {{ testing ? $t('waProxy.testing') : $t('waProxy.test') }}
        </button>
        <button type="button" class="kbtn primary" :disabled="saving" @click="save">{{ $t('waProxy.save') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
</style>
