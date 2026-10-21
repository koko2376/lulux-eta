<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import PermNote from '../components/ui/PermNote.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { can } from '../lib/session'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/** 设置 → 对话与工具：内置内核的循环、重试、上下文、推理与联网搜索（契约 §6.1 / §6.6） */
const store = useAppStore()
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const writable = computed(() => can('settings:write'))

const BOOL_KEYS = [
  'builtinTools',
  'kernelTools',
  'kernelCrmMcp',
  'parallelToolCalls',
  'contextCompaction',
  'autoTitle',
  'agent.budgetPressure',
] as const
const INT_FIELDS = [
  {
    key: 'agent.maxTurns',
    label: t('settingsBuiltin.maxTurns'),
    min: 0,
    max: 500,
    hint: t('settingsBuiltin.maxTurnsHint'),
  },
  {
    key: 'llmMaxRetries',
    label: t('settingsBuiltin.k1awu85b'),
    min: 0,
    max: 8,
    hint: t('settingsBuiltin.kt7ia77'),
  },
  {
    key: 'llmTimeoutSeconds',
    label: t('settingsBuiltin.kc9pury'),
    min: 10,
    max: 600,
    hint: t('settingsBuiltin.k757fkj'),
  },
  { key: 'maxContinuations', label: t('settingsBuiltin.k7sjgqm'), min: 0, max: 5, hint: t('settingsBuiltin.k1oo1i3m') },
] as const
type BoolKey = (typeof BOOL_KEYS)[number]
type IntKey = (typeof INT_FIELDS)[number]['key']

const form = reactive({
  bools: {} as Record<BoolKey, boolean>,
  ints: {} as Record<IntKey, string>,
  reasoningEffort: 'off',
  toolLoading: 'auto' as 'auto' | 'all',
  timezone: '',
  modelCapabilities: '',
})
const capsError = ref('')

const search = reactive({ provider: 'none' as api.SearchProviderId, endpoint: '', apiKey: '', maxResults: '5' })
const searchConfig = ref<api.SearchConfig | null>(null)
const searchSaving = ref(false)
const searchProvider = computed(() => searchConfig.value?.providers.find((p) => p.id === search.provider) ?? null)

const BOOL_LABEL: Record<BoolKey, { label: string; hint: string }> = {
  builtinTools: { label: t('settingsBuiltin.kvrpais'), hint: t('settingsBuiltin.k1d94ue4') },
  kernelTools: { label: t('settingsBuiltin.k1ja9wt7'), hint: t('settingsBuiltin.k1rrh255') },
  kernelCrmMcp: { label: t('settingsBuiltin.kernelCrmMcp'), hint: t('settingsBuiltin.kernelCrmMcpHint') },
  parallelToolCalls: { label: t('settingsBuiltin.k1nkgrcu'), hint: t('settingsBuiltin.k1kg6q4g') },
  contextCompaction: { label: t('settingsBuiltin.kd0h204'), hint: t('settingsBuiltin.k1cd1dal') },
  autoTitle: { label: t('settingsBuiltin.kfshtrn'), hint: t('settingsBuiltin.kgsda3s') },
  'agent.budgetPressure': { label: t('settingsBuiltin.budgetPressure'), hint: t('settingsBuiltin.budgetPressureHint') },
}

function fill(): void {
  const s = store.settings
  for (const key of BOOL_KEYS) form.bools[key] = (s[key] ?? '1') !== '0'
  const defaults: Record<IntKey, string> = {
    'agent.maxTurns': '90',
    llmMaxRetries: '3',
    llmTimeoutSeconds: '120',
    maxContinuations: '2',
  }
  for (const f of INT_FIELDS) form.ints[f.key] = s[f.key] ?? defaults[f.key]
  form.reasoningEffort = s.reasoningEffort || 'off'
  form.toolLoading = s.toolLoading === 'all' ? 'all' : 'auto'
  form.timezone = s.timezone ?? ''
  form.modelCapabilities = s.modelCapabilities ?? ''
}

function fillSearch(config: api.SearchConfig): void {
  searchConfig.value = config
  search.provider = config.provider
  search.endpoint = config.endpoint
  search.apiKey = ''
  search.maxResults = String(config.maxResults || 5)
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await store.refreshSettings()
    fill()
    const config = await api.getSearchConfig().catch(() => null)
    if (config) fillSearch(config)
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

async function save(): Promise<void> {
  capsError.value = ''
  if (form.modelCapabilities.trim()) {
    try {
      const parsed = JSON.parse(form.modelCapabilities)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('settingsBuiltin.k1map3hi'))
    } catch (error) {
      capsError.value = t('settingsBuiltin.k1x0t5a0', [errorText(error)])
      return
    }
  }
  const patch: Record<string, string> = {}
  for (const key of BOOL_KEYS) patch[key] = form.bools[key] ? '1' : '0'
  for (const f of INT_FIELDS) patch[f.key] = String(form.ints[f.key]).trim()
  patch.reasoningEffort = form.reasoningEffort
  patch.toolLoading = form.toolLoading
  patch.timezone = form.timezone.trim()
  patch.modelCapabilities = form.modelCapabilities.trim()
  saving.value = true
  try {
    await store.saveSettings(patch)
    fill()
    toast.success(t('settingsBuiltin.kw7yxnz'))
  } catch {
    /* 全局 toast 已提示（例如 INVALID_SETTING 时区不合法） */
  } finally {
    saving.value = false
  }
}

async function saveSearch(): Promise<void> {
  searchSaving.value = true
  try {
    const input: Parameters<typeof api.putSearchConfig>[0] = {
      provider: search.provider,
      endpoint: search.endpoint.trim(),
      maxResults: Math.min(10, Math.max(1, Number(search.maxResults) || 5)),
    }
    if (search.apiKey.trim()) input.apiKey = search.apiKey.trim()
    fillSearch(await api.putSearchConfig(input))
    toast.success(search.provider === 'none' ? t('settingsBuiltin.kxlpde4') : t('settingsBuiltin.k19i1w2x'))
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    searchSaving.value = false
  }
}

async function clearSearchKey(): Promise<void> {
  searchSaving.value = true
  try {
    fillSearch(await api.putSearchConfig({ provider: search.provider, endpoint: search.endpoint.trim(), apiKey: '' }))
    toast.success(t('settingsBuiltin.k1fd7ffz'))
  } finally {
    searchSaving.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsBuiltin.kkn0hhe')" :sub="$t('settingsBuiltin.k50cjpg')" />
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="settings:write" />
        <StateBlock v-if="loading" state="loading" />
        <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
        <template v-else>
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsBuiltin.k1ady4r1') }}</h2>
                <div class="panel-sub">{{ $t('settingsBuiltin.knh6puc') }}</div>
              </div>
            </div>
            <div class="panel-body">
              <ul class="opt-list">
                <li v-for="key in BOOL_KEYS" :key="key" class="opt">
                  <div class="opt-text">
                    <b>{{ BOOL_LABEL[key].label }}</b>
                    <span>{{ BOOL_LABEL[key].hint }}</span>
                  </div>
                  <UiSwitch
                    v-model="form.bools[key]"
                    :label="BOOL_LABEL[key].label"
                    :disabled="
                      !writable ||
                      (key !== 'builtinTools' &&
                        key !== 'autoTitle' &&
                        key !== 'contextCompaction' &&
                        !form.bools.builtinTools)
                    "
                  />
                </li>
                <li class="opt" data-testid="tool-loading">
                  <div class="opt-text">
                    <b id="tool-loading-title">{{ $t('settingsBuiltin.toolLoading') }}</b>
                    <span>{{
                      form.toolLoading === 'auto'
                        ? $t('settingsBuiltin.toolLoadingAutoHint')
                        : $t('settingsBuiltin.toolLoadingAllHint')
                    }}</span>
                  </div>
                  <div class="segmented" role="radiogroup" aria-labelledby="tool-loading-title">
                    <button
                      v-for="m in ['auto', 'all'] as const"
                      :key="m"
                      type="button"
                      role="radio"
                      :aria-checked="form.toolLoading === m"
                      :class="{ on: form.toolLoading === m }"
                      :disabled="!writable || !form.bools.builtinTools"
                      @click="form.toolLoading = m"
                    >
                      {{ m === 'auto' ? $t('settingsBuiltin.toolLoadingAuto') : $t('settingsBuiltin.toolLoadingAll') }}
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsBuiltin.k1wcf5ht') }}</h2>
                <div class="panel-sub">{{ $t('settingsBuiltin.k1yfk29o') }}</div>
              </div>
            </div>
            <div class="panel-body form-grid">
              <label v-for="f in INT_FIELDS" :key="f.key" class="field">
                <span class="field-label">{{ $t('fmt.paren', [f.label, `${f.min}–${f.max}`]) }}</span>
                <input
                  v-model="form.ints[f.key]"
                  class="input"
                  type="number"
                  :min="f.min"
                  :max="f.max"
                  :name="f.key"
                  :disabled="!writable"
                />
                <span class="field-hint">{{ f.hint }}</span>
              </label>
              <label class="field">
                <span class="field-label">{{ $t('settingsBuiltin.ksfij1a') }}</span>
                <select v-model="form.reasoningEffort" class="select" name="reasoningEffort" :disabled="!writable">
                  <option value="off">{{ $t('settingsBuiltin.ktzla4f') }}</option>
                  <option value="low">{{ $t('settingsBuiltin.k1fl7ee3') }}</option>
                  <option value="medium">{{ $t('settingsBuiltin.k2c0a3g') }}</option>
                  <option value="high">{{ $t('settingsBuiltin.k1czw839') }}</option>
                  <option value="xhigh">{{ $t('settingsBuiltin.effortXhigh') }}</option>
                </select>
                <span class="field-hint">{{ $t('settingsBuiltin.kf9lg5y') }}</span>
              </label>
              <label class="field">
                <span class="field-label">{{ $t('settingsBuiltin.k9c7n9f') }}</span>
                <input
                  v-model="form.timezone"
                  class="input code"
                  name="timezone"
                  :placeholder="$t('settingsBuiltin.k1bedk2e', [browserZone])"
                  spellcheck="false"
                  :disabled="!writable"
                />
                <span class="field-hint">{{ $t('settingsBuiltin.kadwky5') }}</span>
              </label>
            </div>
            <div class="panel-body cap-body">
              <label class="field">
                <span class="field-label">{{ $t('settingsBuiltin.k18tderz') }}</span>
                <textarea
                  v-model="form.modelCapabilities"
                  class="textarea code"
                  rows="4"
                  name="modelCapabilities"
                  spellcheck="false"
                  placeholder='{"my-local-model": {"contextWindow": 32768, "tools": false}}'
                  :disabled="!writable"
                />
                <span v-if="capsError" class="field-error" role="alert">{{ capsError }}</span>
                <span v-else class="field-hint">{{ $t('settingsBuiltin.ki2juz') }}</span>
              </label>
              <div class="hstack">
                <button v-perm="'settings:write'" type="button" class="kbtn primary" :disabled="saving" @click="save">
                  {{ saving ? $t('settingsBuiltin.ksdjf4x') : $t('settingsBuiltin.k1xlvxln') }}
                </button>
              </div>
            </div>
          </section>

          <section class="panel" data-testid="search-config">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsBuiltin.kje7b5z') }}</h2>
                <div class="panel-sub">{{ $t('settingsBuiltin.kiq46ci') }}</div>
              </div>
              <span v-if="searchConfig?.enabled" class="badge-on">{{ $t('settingsBuiltin.kahsoj5') }}</span>
              <span v-else class="badge-off">{{ $t('settingsBuiltin.k12rfs34') }}</span>
            </div>
            <form class="panel-body form-grid" @submit.prevent="saveSearch">
              <label class="field">
                <span class="field-label">{{ $t('settingsBuiltin.kebnxes') }}</span>
                <select v-model="search.provider" class="select" name="searchProvider" :disabled="!writable">
                  <option v-for="p in searchConfig?.providers ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>
              <label v-if="search.provider !== 'none'" class="field">
                <span class="field-label">{{ $t('settingsBuiltin.k7e7536') }}</span>
                <input v-model="search.maxResults" class="input" type="number" min="1" max="10" :disabled="!writable" />
              </label>
              <label v-if="searchProvider && search.provider !== 'none'" class="field span-all">
                <span class="field-label">{{
                  $t('settingsBuiltin.k1yyuk6', [
                    searchProvider.needsEndpoint ? $t('settingsBuiltin.k12m3ddb') : $t('settingsBuiltin.k15ro469'),
                  ])
                }}</span>
                <input
                  v-model="search.endpoint"
                  class="input code"
                  :placeholder="searchProvider.defaultEndpoint || 'https://searx.example.com'"
                  spellcheck="false"
                  :disabled="!writable"
                />
              </label>
              <label v-if="searchProvider?.needsKey" class="field span-all">
                <span class="field-label">API Key</span>
                <input
                  v-model="search.apiKey"
                  class="input code"
                  type="password"
                  autocomplete="off"
                  :placeholder="
                    searchConfig?.hasApiKey
                      ? $t('settingsBuiltin.k1wmkch1', [searchConfig.apiKeyPreview || ''])
                      : $t('settingsBuiltin.k1rqnth7')
                  "
                  :disabled="!writable"
                />
                <span v-if="searchConfig?.apiKeyError" class="field-error">{{ searchConfig.apiKeyError }}</span>
              </label>
              <p v-if="search.provider === 'bing'" class="field-hint span-all">
                {{ $t('settingsBuiltin.kp02665') }}
              </p>
              <div class="hstack span-all">
                <button v-perm="'settings:write'" type="submit" class="kbtn primary" :disabled="searchSaving">
                  {{ searchSaving ? $t('settingsBuiltin.ksdjf4x') : $t('settingsBuiltin.kqxwdui') }}
                </button>
                <button
                  v-if="searchConfig?.hasApiKey && searchProvider?.needsKey"
                  v-perm="'settings:write'"
                  type="button"
                  class="kbtn"
                  :disabled="searchSaving"
                  @click="clearSearchKey"
                >
                  {{ $t('settingsBuiltin.k1ffv7t3') }}
                </button>
              </div>
            </form>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.opt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.opt {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
}
.opt + .opt {
  border-top: 1px solid var(--line);
}
.opt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.opt-text b {
  font-size: 13.5px;
  font-weight: 500;
}
.opt-text span {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.cap-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 0;
}
</style>
