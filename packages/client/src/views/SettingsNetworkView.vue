<script setup lang="ts">
import PermNote from '../components/ui/PermNote.vue'
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const store = useAppStore()
const loading = ref(true)
const loadError = ref('')
const form = reactive({ proxyUrl: '', webhookUrl: '', webhookEnabled: false })
const saving = reactive({ proxy: false, webhook: false })
const testing = reactive({ proxy: false, webhook: false })
const result = reactive<{ proxy: { ok: boolean; text: string } | null; webhook: { ok: boolean; text: string } | null }>(
  { proxy: null, webhook: null },
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await store.refreshSettings()
    form.proxyUrl = store.settings.proxyUrl ?? ''
    form.webhookUrl = store.settings.webhookUrl ?? ''
    form.webhookEnabled = store.settings.webhookEnabled === '1'
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function saveProxy(): Promise<void> {
  saving.proxy = true
  try {
    await store.saveSettings({ proxyUrl: form.proxyUrl.trim() })
    form.proxyUrl = store.settings.proxyUrl ?? form.proxyUrl
    toast.success(form.proxyUrl ? t('settingsNetwork.k2ku486') : t('settingsNetwork.k1lefuol'))
  } finally {
    saving.proxy = false
  }
}

async function testProxy(): Promise<void> {
  testing.proxy = true
  result.proxy = null
  try {
    const res = await api.testProxy(form.proxyUrl.trim() || undefined)
    result.proxy = { ok: true, text: t('settingsNetwork.k140qnt8', [res.status]) }
  } catch (error) {
    result.proxy = { ok: false, text: errorText(error) }
  } finally {
    testing.proxy = false
  }
}

async function saveWebhook(): Promise<void> {
  saving.webhook = true
  try {
    await store.saveSettings({ webhookUrl: form.webhookUrl.trim(), webhookEnabled: form.webhookEnabled ? '1' : '0' })
    toast.success(t('settingsNetwork.kpj4vyf'))
  } finally {
    saving.webhook = false
  }
}

async function testWebhook(): Promise<void> {
  testing.webhook = true
  result.webhook = null
  try {
    const res = await api.testWebhook(form.webhookUrl.trim() || undefined)
    result.webhook = { ok: true, text: t('settingsNetwork.k13499nr', [res.status]) }
  } catch (error) {
    result.webhook = { ok: false, text: errorText(error) }
  } finally {
    testing.webhook = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsNetwork.km51t7t')" :sub="$t('settingsNetwork.kwpw2n2')" />
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="settings:write" />
        <StateBlock v-if="loading" state="loading" />
        <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
        <template v-else>
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsNetwork.k1ob99yy') }}</h2>
                <div class="panel-sub">{{ $t('settingsNetwork.k1uz07gz') }}</div>
              </div>
            </div>
            <form class="panel-body stack" @submit.prevent="saveProxy">
              <label class="field">
                <span class="field-label">{{ $t('settingsNetwork.k140uss6') }}</span>
                <input
                  v-model="form.proxyUrl"
                  class="input code"
                  placeholder="http://127.0.0.1:7890"
                  spellcheck="false"
                />
              </label>
              <div class="hstack">
                <button v-perm="'settings:write'" type="submit" class="kbtn primary" :disabled="saving.proxy">
                  {{ saving.proxy ? $t('settingsNetwork.ksdjf4x') : $t('settingsNetwork.k1xlvxln') }}
                </button>
                <button
                  type="button"
                  class="kbtn"
                  :disabled="testing.proxy || !form.proxyUrl.trim()"
                  @click="testProxy"
                >
                  {{ testing.proxy ? $t('settingsNetwork.kkcjegh') : $t('settingsNetwork.k4mzqwc') }}
                </button>
                <span v-if="result.proxy" class="result" :class="result.proxy.ok ? 'ok' : 'bad'" role="status">{{
                  result.proxy.text
                }}</span>
              </div>
            </form>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsNetwork.kapdu7') }}</h2>
                <div class="panel-sub">
                  {{ $t('settingsNetwork.kqeo4m5') }}
                </div>
              </div>
              <UiSwitch v-model="form.webhookEnabled" :label="$t('settingsNetwork.k1k0np6p')" />
            </div>
            <form class="panel-body stack" @submit.prevent="saveWebhook">
              <label class="field">
                <span class="field-label">{{ $t('settingsNetwork.k154kr6i') }}</span>
                <input
                  v-model="form.webhookUrl"
                  class="input code"
                  placeholder="https://example.com/hook"
                  spellcheck="false"
                />
              </label>
              <div class="hstack">
                <button v-perm="'settings:write'" type="submit" class="kbtn primary" :disabled="saving.webhook">
                  {{ saving.webhook ? $t('settingsNetwork.ksdjf4x') : $t('settingsNetwork.k1xlvxln') }}
                </button>
                <button
                  type="button"
                  class="kbtn"
                  :disabled="testing.webhook || !form.webhookUrl.trim()"
                  @click="testWebhook"
                >
                  {{ testing.webhook ? $t('settingsNetwork.k1hr0wnc') : $t('settingsNetwork.kar3sau') }}
                </button>
                <span v-if="result.webhook" class="result" :class="result.webhook.ok ? 'ok' : 'bad'" role="status">{{
                  result.webhook.text
                }}</span>
              </div>
              <p class="field-hint">{{ $t('settingsNetwork.k1t2rpnw') }}</p>
            </form>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.result {
  font-size: 12.5px;
}
.result.ok {
  color: var(--good);
}
.result.bad {
  color: var(--danger);
}
</style>
