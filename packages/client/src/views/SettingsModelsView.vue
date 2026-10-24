<script setup lang="ts">
import FieldError from '../components/ui/FieldError.vue'
import { useFieldErrors } from '../composables/useFieldErrors'
import PermNote from '../components/ui/PermNote.vue'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import * as api from '../api'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import AppIcon from '../components/AppIcon.vue'
import { getCapabilities } from '../api/builtin'
import { can } from '../lib/session'
import { setVisionOverride } from '../lib/vision-settings'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import { PROVIDER_PRESETS, parseModelList } from '../lib/provider-presets'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const store = useAppStore()
const route = useRoute()
const loading = ref(true)
const loadError = ref('')
const busy = reactive<Record<string, string>>({})
const testResult = reactive<Record<string, { ok: boolean; text: string }>>({})

const defaultId = computed(() => store.defaultProvider?.id ?? null)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await Promise.all([store.refreshProviders(), store.refreshSettings()])
    void loadVision()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
  // 列表渲染出来之后再定位
  if (!loadError.value) void focusFromRoute()
}
onMounted(load)

/* ── 看图（vision）：按模型名的默认值，可在这里按当前模型覆盖（写入设置 modelCapabilities） ── */
const vision = reactive<Record<string, { model: string; on: boolean }>>({})
const canWriteSettings = computed(() => can('settings:write'))
async function loadVision(): Promise<void> {
  await Promise.all(
    store.providers.map(async (provider) => {
      if (!provider.model) return
      const res = await getCapabilities({ providerId: provider.id }).catch(() => null)
      if (res) vision[provider.id] = { model: res.model, on: res.capabilities.vision }
    }),
  )
}
async function toggleVision(provider: api.Provider, on: boolean): Promise<void> {
  if (!provider.model) return
  busy[provider.id] = 'vision'
  try {
    await store.saveSettings({
      modelCapabilities: setVisionOverride(store.settings.modelCapabilities ?? '', provider.model, on),
    })
    vision[provider.id] = { model: provider.model, on }
    toast.success(t(on ? 'vision.capOn' : 'vision.capOff', [provider.model]))
  } catch {
    // 全局 toast 已提示
  } finally {
    delete busy[provider.id]
  }
}

/* ── 按模型的思考强度（手动覆盖自动检测，写入 Provider；输入框滑块随之变化） ── */
const REASONING_OPTIONS: api.ReasoningChoice[] = ['openai', 'anthropic', 'qwen', 'toggle', 'fixed', 'none']
const canWriteProviders = computed(() => can('providers:write'))
const reasoningOpen = reactive<Record<string, boolean>>({})
const focused = ref<{ provider: string; model: string } | null>(null)

function choiceLabel(choice: api.ReasoningChoice): string {
  return t(`settingsModels.choice_${choice}`)
}
function reasoningValue(provider: api.Provider, model: string): string {
  return provider.modelReasoning?.[model]?.manual ?? 'auto'
}
function autoLabel(provider: api.Provider, model: string): string {
  const info = provider.modelReasoning?.[model]
  const label = choiceLabel(info?.auto ?? 'none')
  return info?.detected ? `${label} · ${t('settingsModels.reasoningDetected')}` : label
}
function isFocused(provider: api.Provider, model: string): boolean {
  return focused.value?.provider === provider.id && focused.value.model === model
}
async function setReasoning(provider: api.Provider, model: string, value: string): Promise<void> {
  busy[provider.id] = 'reasoning'
  try {
    await api.setModelReasoning(provider.id, model, value as api.ReasoningChoice | 'auto')
    await store.refreshProviders()
    void store.refreshModelCatalogs()
    toast.success(t('settingsModels.reasoningSaved', [model]))
  } catch {
    // 全局 toast 已提示
  } finally {
    delete busy[provider.id]
  }
}
/** 从输入框“去设置”跳过来（?provider=…&model=…）：展开该 Provider 的思考强度并定位到模型 */
async function focusFromRoute(): Promise<void> {
  const providerId = typeof route?.query.provider === 'string' ? route.query.provider : ''
  const model = typeof route?.query.model === 'string' ? route.query.model : ''
  if (!providerId || !store.providers.some((p) => p.id === providerId)) return
  reasoningOpen[providerId] = true
  focused.value = model ? { provider: providerId, model } : null
  await nextTick()
  const panel = document.querySelector<HTMLElement>(`[data-testid="reasoning-${providerId}"]`)
  const row = [...(panel?.querySelectorAll<HTMLElement>('[data-reasoning-model]') ?? [])].find(
    (el) => el.dataset.reasoningModel === model,
  )
  const target = row ?? panel
  target?.scrollIntoView?.({ block: 'center' })
  target?.querySelector<HTMLSelectElement>('select')?.focus()
}

/* ── 编辑框 ── */
const editing = ref<api.Provider | null>(null)
const showForm = ref(false)
const saving = ref(false)
const formError = ref('')
const form = reactive({
  preset: 'custom',
  name: '',
  kind: 'openai' as api.ProviderKind,
  baseUrl: '',
  apiKey: '',
  model: '',
  modelsText: '',
})

function openCreate(): void {
  editing.value = null
  Object.assign(form, {
    preset: 'custom',
    name: '',
    kind: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    modelsText: '',
  })
  formError.value = ''
  showForm.value = true
}

function openEdit(provider: api.Provider): void {
  editing.value = provider
  Object.assign(form, {
    preset: PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl === provider.baseUrl)?.id ?? 'custom',
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: '',
    model: provider.model,
    modelsText: provider.models.join('\n'),
  })
  formError.value = ''
  showForm.value = true
}

const currentPreset = computed(() => PROVIDER_PRESETS.find((p) => p.id === form.preset) ?? PROVIDER_PRESETS[0])

function applyPreset(): void {
  const preset = currentPreset.value
  if (preset.id === 'custom') return
  form.kind = preset.kind
  form.baseUrl = preset.baseUrl
  if (!form.name || PROVIDER_PRESETS.some((p) => p.label === form.name)) form.name = preset.label
}

const fe = useFieldErrors<'name' | 'baseUrl'>('provider-form')
async function save(): Promise<void> {
  formError.value = ''
  fe.clear()
  const named = fe.require({ name: form.name }, () => t('settingsModels.k5tvey4'))
  if (!form.baseUrl.trim()) fe.set('baseUrl', t('ui.required'))
  else if (!/^https?:\/\/.+/i.test(form.baseUrl.trim())) fe.set('baseUrl', t('settingsModels.k1k4s74k'))
  if (!named || fe.errors.baseUrl) return
  if (!editing.value && currentPreset.value.needsKey && !form.apiKey.trim()) {
    return void (formError.value = t('settingsModels.kn0hipp'))
  }
  const models = parseModelList(form.modelsText)
  const model = form.model.trim() || models[0] || ''
  if (model && !models.includes(model)) models.unshift(model)
  const input: Partial<api.ProviderInput> = {
    name: form.name.trim(),
    kind: form.kind,
    baseUrl: form.baseUrl.trim(),
    model,
    models,
  }
  // key 只写不读：留空代表不修改
  if (form.apiKey.trim()) input.apiKey = form.apiKey.trim()
  saving.value = true
  try {
    if (editing.value) {
      await api.updateProvider(editing.value.id, input)
      toast.success(t('settingsModels.k1l5gy27'))
    } else {
      const created = await api.createProvider(input as api.ProviderInput)
      if (!store.settings.defaultProviderId && store.providers.length === 0) {
        await store.saveSettings({ defaultProviderId: created.id }).catch(() => undefined)
      }
      toast.success(t('settingsModels.kg0faj4', [created.name]))
    }
    form.apiKey = ''
    showForm.value = false
    await store.refreshProviders()
    await store.refreshAgents().catch(() => undefined)
  } catch (error) {
    formError.value = errorText(error)
  } finally {
    saving.value = false
  }
}

/* ── 行操作 ── */
async function testConnection(provider: api.Provider): Promise<void> {
  busy[provider.id] = 'test'
  delete testResult[provider.id]
  try {
    const { models } = await api.discoverProviderModels(provider.id, { silent: true })
    testResult[provider.id] = { ok: true, text: t('settingsModels.kdk0bs', [models.length]) }
    await store.refreshProviders()
  } catch (error) {
    testResult[provider.id] = { ok: false, text: errorText(error) }
  } finally {
    delete busy[provider.id]
  }
}

async function fetchModels(provider: api.Provider): Promise<void> {
  busy[provider.id] = 'models'
  try {
    const { models } = await api.discoverProviderModels(provider.id)
    toast.success(t('settingsModels.komrjaa', [models.length]))
    await store.refreshProviders()
  } catch {
    // 全局 toast 已提示
  } finally {
    delete busy[provider.id]
  }
}

async function chooseModel(provider: api.Provider, model: string): Promise<void> {
  if (model === provider.model) return
  busy[provider.id] = 'model'
  try {
    await api.updateProvider(provider.id, { model })
    await store.refreshProviders()
    toast.success(t('settingsModels.kg77gky', [model]))
    void loadVision()
  } finally {
    delete busy[provider.id]
  }
}

async function makeDefault(provider: api.Provider): Promise<void> {
  await store.saveSettings({ defaultProviderId: provider.id })
  toast.success(t('settingsModels.k1a6djtr', [provider.name]))
}

async function remove(provider: api.Provider): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsModels.k8t1ghu', [provider.name]),
    message: t('settingsModels.k18a3rt'),
    confirmText: t('settingsModels.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  busy[provider.id] = 'delete'
  try {
    await api.deleteProvider(provider.id)
    await Promise.all([store.refreshProviders(), store.refreshSettings()])
    toast.success(t('settingsModels.k1xqwrmq'))
  } finally {
    delete busy[provider.id]
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsModels.k1fhxwr2')" :sub="$t('settingsModels.k1vvab0t')">
      <button v-perm="'providers:write'" type="button" class="kbtn primary" @click="openCreate">
        {{ $t('settingsModels.kuklusi') }}
      </button>
    </PageTopbar>

    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="providers:write" :text="$t('settingsModels.k1bvzd5x')" />
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsModels.keebjvn') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsModels.k8lrzgt') }}
              </div>
            </div>
          </div>

          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!store.providers.length"
            state="empty"
            :title="$t('settingsModels.k1yag77x')"
            :message="$t('settingsModels.kaeh5cy')"
            compact
          >
            <button v-perm="'providers:write'" type="button" class="kbtn primary" @click="openCreate">
              {{ $t('settingsModels.kuklusi') }}
            </button>
          </StateBlock>

          <div v-else>
            <div v-for="provider in store.providers" :key="provider.id" class="row-item prov">
              <InitialBadge :name="provider.name" :size="36" square />
              <div class="grow">
                <div class="t">
                  {{ provider.name }}
                  <span v-if="defaultId === provider.id" class="badge-on">{{ $t('settingsModels.k1jpvto9') }}</span>
                  <span class="badge-off">{{
                    provider.kind === 'anthropic' ? $t('settingsModels.kxzpc9q') : $t('settingsModels.k10itth2')
                  }}</span>
                </div>
                <div class="d code">{{ provider.baseUrl }}</div>
                <div class="d">
                  {{
                    $t('settingsModels.k1mzqi5j', [
                      provider.hasApiKey
                        ? provider.apiKeyPreview || $t('settingsModels.k1l5gy27')
                        : $t('settingsModels.knrana0'),
                    ])
                  }}
                </div>
                <p v-if="provider.apiKeyError" class="test-line bad" role="alert">
                  {{ provider.apiKeyError }}
                  <button type="button" class="link u" @click="openEdit(provider)">
                    {{ $t('settingsModels.k1fm2ins') }}
                  </button>
                </p>
                <div class="model-line">
                  <label class="sr-only" :for="`model-${provider.id}`">{{ $t('settingsModels.k1efg4rg') }}</label>
                  <span class="d">{{ $t('settingsModels.k1efg4rg') }}</span>
                  <select
                    :id="`model-${provider.id}`"
                    class="select sm"
                    :value="provider.model"
                    :disabled="!provider.models.length || Boolean(busy[provider.id])"
                    @change="chooseModel(provider, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-if="!provider.models.length" value="">{{ $t('settingsModels.k1yng8ih') }}</option>
                    <option v-for="m in provider.models" :key="m" :value="m">{{ m }}</option>
                  </select>
                  <span
                    v-if="provider.model && vision[provider.id]"
                    class="vision-cap"
                    :title="$t('vision.capHint')"
                    :data-testid="`vision-${provider.id}`"
                  >
                    <span class="d">{{ $t('vision.capLabel') }}</span>
                    <UiSwitch
                      :model-value="vision[provider.id].on"
                      :label="`${$t('vision.capLabel')} · ${provider.model}`"
                      :disabled="!canWriteSettings || Boolean(busy[provider.id])"
                      @update:model-value="toggleVision(provider, $event)"
                    />
                  </span>
                  <button
                    type="button"
                    class="link u reasoning-toggle"
                    :aria-expanded="Boolean(reasoningOpen[provider.id])"
                    :data-testid="`reasoning-toggle-${provider.id}`"
                    @click="reasoningOpen[provider.id] = !reasoningOpen[provider.id]"
                  >
                    {{ $t('settingsModels.reasoningToggle') }}
                    <AppIcon
                      name="chevron-down"
                      :size="13"
                      class="reasoning-chevron"
                      :class="{ open: reasoningOpen[provider.id] }"
                    />
                  </button>
                </div>
                <div
                  v-if="reasoningOpen[provider.id]"
                  class="reasoning-panel"
                  :data-testid="`reasoning-${provider.id}`"
                >
                  <div class="reasoning-head">
                    <strong>{{ $t('settingsModels.reasoningTitle') }}</strong>
                    <span class="d">{{ $t('settingsModels.reasoningHint') }}</span>
                    <span v-if="!canWriteProviders" class="d">{{ $t('settingsModels.reasoningReadonly') }}</span>
                  </div>
                  <p v-if="!provider.models.length" class="d">{{ $t('settingsModels.reasoningNoModels') }}</p>
                  <div
                    v-for="m in provider.models"
                    :key="m"
                    class="reasoning-row"
                    :class="{ focused: isFocused(provider, m) }"
                    :data-reasoning-model="m"
                  >
                    <span class="reasoning-name code" :title="m">{{ m }}</span>
                    <select
                      class="select sm"
                      :value="reasoningValue(provider, m)"
                      :aria-label="`${$t('settingsModels.reasoningToggle')} · ${m}`"
                      :disabled="!canWriteProviders || Boolean(busy[provider.id])"
                      @change="setReasoning(provider, m, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="auto">{{ $t('settingsModels.reasoningAuto', [autoLabel(provider, m)]) }}</option>
                      <option v-for="choice in REASONING_OPTIONS" :key="choice" :value="choice">
                        {{ choiceLabel(choice) }}
                      </option>
                    </select>
                  </div>
                </div>
                <p
                  v-if="testResult[provider.id]"
                  class="test-line"
                  :class="testResult[provider.id].ok ? 'ok' : 'bad'"
                  role="status"
                >
                  {{ testResult[provider.id].text }}
                </p>
              </div>
              <div class="panel-actions acts">
                <button
                  type="button"
                  class="kbtn sm"
                  :disabled="Boolean(busy[provider.id])"
                  @click="testConnection(provider)"
                >
                  {{ busy[provider.id] === 'test' ? $t('settingsModels.kkcjegh') : $t('settingsModels.k4mzqwc') }}
                </button>
                <button
                  type="button"
                  class="kbtn sm"
                  :disabled="Boolean(busy[provider.id])"
                  @click="fetchModels(provider)"
                >
                  {{ busy[provider.id] === 'models' ? $t('settingsModels.k4478hr') : $t('settingsModels.k1gjobxs') }}
                </button>
                <button
                  v-if="defaultId !== provider.id"
                  v-perm="'providers:write'"
                  type="button"
                  class="kbtn sm"
                  @click="makeDefault(provider)"
                >
                  {{ $t('settingsModels.kn5772y') }}
                </button>
                <button v-perm="'providers:write'" type="button" class="kbtn sm" @click="openEdit(provider)">
                  {{ $t('settingsModels.k1alsnuo') }}
                </button>
                <button
                  type="button"
                  class="kbtn sm danger"
                  :disabled="Boolean(busy[provider.id])"
                  @click="remove(provider)"
                >
                  {{ $t('settingsModels.kfcqesv') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <div class="note">
          <span>{{ $t('settingsModels.k1k4m2db') }}</span>
        </div>
      </div>
    </div>

    <UiModal
      v-if="showForm"
      :title="editing ? $t('settingsModels.kx9psfj', [editing.name]) : $t('settingsModels.kuklusi')"
      :width="560"
      @close="showForm = false"
    >
      <form id="provider-form" class="form-grid" novalidate @submit.prevent="save">
        <label class="field span-all">
          <span class="field-label">{{ $t('settingsModels.k16qbd10') }}</span>
          <select v-model="form.preset" class="select" @change="applyPreset">
            <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
          </select>
          <span v-if="currentPreset.hint" class="field-hint">{{ currentPreset.hint }}</span>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('settingsModels.k7qqgy7') }}</span>
          <input
            v-model="form.name"
            class="input"
            :class="{ invalid: fe.errors.name }"
            data-field="name"
            maxlength="60"
            required
            @input="fe.clear('name')"
          />
          <FieldError :msg="fe.errors.name" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('settingsModels.k1d1o4fb') }}</span>
          <select v-model="form.kind" class="select">
            <option value="openai">{{ $t('settingsModels.k10itth2') }}</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label class="field span-all">
          <span class="field-label">Base URL</span>
          <input
            v-model="form.baseUrl"
            class="input code"
            :class="{ invalid: fe.errors.baseUrl }"
            data-field="baseUrl"
            placeholder="https://…/v1"
            spellcheck="false"
            required
            @input="fe.clear('baseUrl')"
          />
          <FieldError :msg="fe.errors.baseUrl" />
        </label>
        <label class="field span-all">
          <span class="field-label">API Key</span>
          <input
            v-model="form.apiKey"
            class="input code"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="
              editing
                ? editing.hasApiKey
                  ? $t('settingsModels.k177gq6i', [editing.apiKeyPreview || $t('settingsModels.k1l5gy27')])
                  : $t('settingsModels.k1drhzcj')
                : currentPreset.needsKey
                  ? 'sk-…'
                  : $t('settingsModels.kgd5bgg')
            "
          />
          <span class="field-hint">{{ $t('settingsModels.k1vxxzce') }}</span>
        </label>
        <label class="field span-all">
          <span class="field-label">{{ $t('settingsModels.k1efg4rg') }}</span>
          <input
            v-model="form.model"
            :title="form.model || undefined"
            class="input code"
            list="model-options"
            :placeholder="$t('settingsModels.k1wseb4s')"
            spellcheck="false"
          />
          <datalist id="model-options">
            <option v-for="m in parseModelList(form.modelsText)" :key="m" :value="m" />
          </datalist>
        </label>
        <label class="field span-all">
          <span class="field-label">{{ $t('settingsModels.koyenob') }}</span>
          <textarea
            v-model="form.modelsText"
            class="textarea code model-list"
            rows="3"
            wrap="off"
            spellcheck="false"
          ></textarea>
        </label>
        <p v-if="formError" class="field-error span-all" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('settingsModels.kldkknc') }}</button>
        <button type="submit" form="provider-form" class="kbtn primary" :disabled="saving">
          {{ saving ? $t('settingsModels.ksdjf4x') : $t('settingsModels.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.prov {
  align-items: flex-start;
}
.acts {
  justify-content: flex-end;
  max-width: 320px;
}
.model-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
}
/* 模型名很长时：标签不折行，下拉框占满剩余宽度并截断 */
.model-line .d {
  flex: none;
  margin-top: 0;
  white-space: nowrap;
}
.vision-cap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-left: 6px;
}
.reasoning-toggle {
  flex: none;
  gap: 3px;
  margin-left: 6px;
  padding: 3px 8px 3px 10px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--hover-overlay);
  text-decoration: none;
}
.reasoning-toggle:hover {
  color: var(--text);
  background: rgba(var(--ink-rgb), 0.1);
}
.reasoning-chevron {
  transition: transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}
.reasoning-chevron.open {
  transform: rotate(180deg);
}
.reasoning-panel {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(var(--ink-rgb), 0.06);
  border-radius: 14px;
  background: var(--surface-soft);
}
.reasoning-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
  font-size: 12.5px;
}
.reasoning-head .d {
  margin-top: 0;
}
.reasoning-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  min-width: 0;
}
.reasoning-row.focused {
  background: var(--surface-active);
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.reasoning-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.select.sm {
  height: 30px;
  width: auto;
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(100%, 420px);
  font-size: 12.5px;
  text-overflow: ellipsis;
}
.model-list {
  /* 一行一个模型名：不在名字中间折行，过长时横向滚动 */
  white-space: pre;
  overflow-x: auto;
}
.test-line {
  margin: 8px 0 0;
  font-size: 12px;
}
.test-line.ok {
  color: var(--good);
}
.test-line.bad {
  color: var(--danger);
}
@media (max-width: 1180px) {
  .prov {
    flex-wrap: wrap;
  }
  .acts {
    max-width: none;
    width: 100%;
    justify-content: flex-start;
    padding-left: 50px;
  }
}
</style>
