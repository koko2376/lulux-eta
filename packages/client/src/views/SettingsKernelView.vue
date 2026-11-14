<script setup lang="ts">
import ServerFeatureNote from '../components/ui/ServerFeatureNote.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { kernelDescription, kernelName, kernelSizeHint } from '../lib/kernel'
import { kernelAvatar } from '../lib/kernel-logos'
import { can, denyReason } from '../lib/session'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { labelled, t } from '../i18n'

const store = useAppStore()
/**
 * 内核头像：与会话内核选择器同一套内核头像（Hermes / Pi / Codex / Claude Code 的角色 png，
 * Gemini CLI / Qwen Code 的 svg 标志，LULUX 的产品图标）；未知内核用服务端 avatar，再没有就退回首字母
 */
const kernelIcon = (k: api.Kernel): { src: string; tile: boolean } | null =>
  kernelAvatar(k.id) ?? (k.avatar ? { src: k.avatar, tile: false } : null)
const kernels = ref<api.Kernel[]>([])
const loading = ref(true)
const loadError = ref('')
const pending = ref<Record<string, boolean>>({})
let timer = 0

/* 安装源（设置项 kernelRegistry）：第三方内核与技能脚本的 npm 依赖都从这里装 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
const registryDraft = ref('')
const registrySaving = ref(false)
const registryError = ref('')
const registrySaved = computed(() => store.settings.kernelRegistry ?? '')
watch(registrySaved, (value) => (registryDraft.value = value), { immediate: true })
async function saveRegistry(): Promise<void> {
  registryError.value = ''
  const value = registryDraft.value.trim()
  if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
    registryError.value = t('settingsKernel.kokj53q')
    return
  }
  registrySaving.value = true
  try {
    await store.saveSettings({ kernelRegistry: value })
    registryDraft.value = store.settings.kernelRegistry ?? value
    toast.success(value ? t('settingsKernel.kv8wzul') : t('settingsKernel.k1159ljn'))
  } catch (error) {
    registryError.value = errorText(error)
  } finally {
    registrySaving.value = false
  }
}

const busy = (k: api.Kernel) => k.status === 'installing' || k.status === 'uninstalling'
const anyBusy = computed(() => kernels.value.some(busy))

/* ── 运行限制：kernelIdleTimeoutSeconds / kernelMaxRunMinutes ──
 * 服务端 settings-schema.ts 是唯一事实源（默认 600 秒 / 60 分钟，范围 0–86400 / 0–1440，0 = 不限制）：
 * 这里读 /api/settings/schema 拿到范围与默认值；拿不到（旧服务端）时退回同一组常量。 */
const IDLE_KEY = 'kernelIdleTimeoutSeconds'
const MAXRUN_KEY = 'kernelMaxRunMinutes'
const IDLE_DEFAULT = '600'
const MAXRUN_DEFAULT = '60'
const IDLE_MIN = 0
const IDLE_MAX = 86400
const MAXRUN_MIN = 0
const MAXRUN_MAX = 1440

const idleDraft = ref('')
const maxRunDraft = ref('')
const limitsSaving = ref(false)
const limitsError = ref('')
const savedIdle = ref(IDLE_DEFAULT)
const savedMaxRun = ref(MAXRUN_DEFAULT)
const idleDefault = ref(IDLE_DEFAULT)
const maxRunDefault = ref(MAXRUN_DEFAULT)
const idleRange = ref({ min: IDLE_MIN, max: IDLE_MAX })
const maxRunRange = ref({ min: MAXRUN_MIN, max: MAXRUN_MAX })

const idleIsUnlimited = computed(() => idleDraft.value.trim() === '0')
const maxRunIsUnlimited = computed(() => maxRunDraft.value.trim() === '0')
const limitsDirty = computed(
  () => idleDraft.value.trim() !== savedIdle.value || maxRunDraft.value.trim() !== savedMaxRun.value,
)

/** 读服务端 schema 的范围 / 默认值（只取本区块要用的两个键） */
async function loadLimitSchema(): Promise<void> {
  try {
    const schema = await api.getSettingsSchema()
    const idle = schema.find((item) => item.key === IDLE_KEY)
    const maxRun = schema.find((item) => item.key === MAXRUN_KEY)
    if (idle) {
      idleDefault.value = String(idle.default ?? IDLE_DEFAULT)
      idleRange.value = { min: idle.min ?? IDLE_MIN, max: idle.max ?? IDLE_MAX }
    }
    if (maxRun) {
      maxRunDefault.value = String(maxRun.default ?? MAXRUN_DEFAULT)
      maxRunRange.value = { min: maxRun.min ?? MAXRUN_MIN, max: maxRun.max ?? MAXRUN_MAX }
    }
  } catch {
    /* 旧服务端没有 schema 接口：用同一组默认常量 */
  }
}

/** 设置里的当前值 → 输入框（服务端没存过就是默认值） */
function syncLimits(): void {
  savedIdle.value = store.settings[IDLE_KEY] ?? idleDefault.value ?? IDLE_DEFAULT
  savedMaxRun.value = store.settings[MAXRUN_KEY] ?? maxRunDefault.value ?? MAXRUN_DEFAULT
  idleDraft.value = savedIdle.value
  maxRunDraft.value = savedMaxRun.value
}
watch([() => store.settings[IDLE_KEY], () => store.settings[MAXRUN_KEY]], syncLimits, { immediate: true })

/** 前端校验：必须是整数且在范围内（服务端 PATCH 也会以 400 INVALID_SETTING 拒绝） */
function checkLimit(value: string, range: { min: number; max: number }): string {
  const raw = value.trim()
  if (!/^-?\d+$/.test(raw)) return t('settingsKernel.limitsInteger')
  const n = Number(raw)
  if (n < range.min || n > range.max) return t('settingsKernel.limitsRange', [range.min, range.max])
  return ''
}

async function saveLimits(): Promise<void> {
  limitsError.value = ''
  const idle = checkLimit(idleDraft.value, idleRange.value)
  const maxRun = checkLimit(maxRunDraft.value, maxRunRange.value)
  if (idle || maxRun) {
    limitsError.value = idle || maxRun
    return
  }
  limitsSaving.value = true
  try {
    await store.saveSettings({ [IDLE_KEY]: idleDraft.value.trim(), [MAXRUN_KEY]: maxRunDraft.value.trim() })
    syncLimits()
    toast.success(t('settingsKernel.limitsSaved'))
  } catch (error) {
    // 服务端拒绝（400 INVALID_SETTING / 403）照原样显示，不吞
    limitsError.value = errorText(error)
  } finally {
    limitsSaving.value = false
  }
}

/** 恢复默认（只填回输入框，仍需点保存才写入，避免误改） */
function resetLimits(): void {
  limitsError.value = ''
  idleDraft.value = idleDefault.value
  maxRunDraft.value = maxRunDefault.value
}


async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    const previous = new Map(kernels.value.map((k) => [k.id, k]))
    kernels.value = await api.listKernels({ silent })
    loadError.value = ''
    for (const k of kernels.value) {
      const before = previous.get(k.id)
      if (before && busy(before) && !busy(k)) {
        if (k.status === 'error') toast.error(labelled(kernelName(k), k.error || t('settingsKernel.k2qst6d')))
        else
          toast.success(
            `${kernelName(k)} ${k.installed ? t('settingsKernel.k10m0fb3', [k.version ?? '']) : t('settingsKernel.k1i0kins')}`,
          )
        store.refreshAgents().catch(() => undefined)
      }
    }
  } catch (error) {
    if (!silent) loadError.value = errorText(error)
  } finally {
    loading.value = false
    schedule()
  }
}

/** 有任务进行中时每秒轮询（契约：202 后轮询 GET 直到 idle/error） */
function schedule(): void {
  window.clearTimeout(timer)
  if (anyBusy.value) timer = window.setTimeout(() => load(true), 1000)
}

onMounted(() => {
  void load()
  void loadProviders()
  void loadLimitSchema()
  store.refreshSettings().catch(() => undefined)
})

/* ── 运行模式（契约 §6）：scoped 用 LULUX 的 Provider 经本机网关；global 用 CLI 自己的登录 ── */
const providers = ref<api.Provider[]>([])
const defaultProviderId = ref('')
async function loadProviders(): Promise<void> {
  try {
    const [list, settings] = await Promise.all([api.listProviders(), api.listSettings()])
    providers.value = list
    defaultProviderId.value = settings.defaultProviderId ?? ''
  } catch {
    providers.value = []
  }
}
const modeSaving = ref<Record<string, boolean>>({})
async function setMode(k: api.Kernel, mode: api.KernelMode): Promise<void> {
  if (!k.modeSettingKey || k.mode === mode) return
  modeSaving.value[k.id] = true
  try {
    await api.updateSettings({ [k.modeSettingKey]: mode })
    await load(true)
    await store.refreshAgents().catch(() => undefined)
    toast.success(
      mode === 'scoped' ? t('settingsKernel.k1tohcmd', [kernelName(k)]) : t('settingsKernel.kxrxm4q', [kernelName(k)]),
    )
  } finally {
    modeSaving.value[k.id] = false
  }
}
/** scoped 内核共用“默认 Provider / 模型”（与 LULUX 角色相同；会话可以单独指定） */
const modelChoices = computed(() =>
  providers.value.flatMap((p) =>
    (p.models.length ? p.models : [p.model])
      .filter(Boolean)
      .map((m) => ({ value: `${p.id}::${m}`, label: `${p.name} / ${m}` })),
  ),
)
async function setScopedModel(value: string): Promise<void> {
  const [providerId, model] = value.split('::')
  const provider = providers.value.find((p) => p.id === providerId)
  if (!provider) return
  if (provider.model !== model) await api.updateProvider(provider.id, { model })
  if (defaultProviderId.value !== providerId) await api.updateSettings({ defaultProviderId: providerId })
  await Promise.all([loadProviders(), load(true)])
  await store.refreshAgents().catch(() => undefined)
  toast.success(t('settingsKernel.k1bipwu5', [provider.name, model]))
}
const canChangeModel = computed(() => can('providers:write') && can('settings:write'))
onBeforeUnmount(() => window.clearTimeout(timer))

async function run(kernel: api.Kernel, action: 'install' | 'update' | 'uninstall'): Promise<void> {
  if (action === 'uninstall') {
    const ok = await confirmDialog({
      title: t('settingsKernel.k1ppoq5k', [kernelName(kernel)]),
      message: t('settingsKernel.k1qp5tlx'),
      confirmText: t('settingsKernel.k8w56qd'),
      danger: true,
    })
    if (!ok) return
  }
  pending.value[kernel.id] = true
  try {
    const next = await api.kernelAction(kernel.id, action)
    const index = kernels.value.findIndex((k) => k.id === kernel.id)
    if (index >= 0 && next && next.id) kernels.value.splice(index, 1, next)
    else await load(true)
    schedule()
  } finally {
    pending.value[kernel.id] = false
  }
}

/* ── 日志 ── */
const logKernel = ref<api.Kernel | null>(null)
const logLines = ref<string[]>([])
const logLoading = ref(false)
const logError = ref('')
let logTimer = 0
const logBox = ref<HTMLElement | null>(null)

async function loadLog(): Promise<void> {
  const k = logKernel.value
  if (!k) return
  // 安装进行中日志会增长：用户停在底部（或首次打开）时跟随到最新一行
  const box = logBox.value
  const follow = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24
  try {
    logLines.value = await api.kernelLog(k.id)
    logError.value = ''
    if (follow) void nextTick(() => logBox.value && (logBox.value.scrollTop = logBox.value.scrollHeight))
  } catch (error) {
    logError.value = errorText(error)
  } finally {
    logLoading.value = false
  }
  const live = kernels.value.find((item) => item.id === k.id)
  window.clearTimeout(logTimer)
  if (live && busy(live) && logKernel.value) logTimer = window.setTimeout(loadLog, 1500)
}

function openLog(kernel: api.Kernel): void {
  logKernel.value = kernel
  logLines.value = []
  logLoading.value = true
  void loadLog()
}
function closeLog(): void {
  logKernel.value = null
  window.clearTimeout(logTimer)
}
onBeforeUnmount(() => window.clearTimeout(logTimer))

function statusText(k: api.Kernel): string {
  if (k.status === 'installing') return k.installed ? t('settingsKernel.kdklbo1') : t('settingsKernel.k1qdj94f')
  if (k.status === 'uninstalling') return t('settingsKernel.kikecf4')
  if (k.status === 'error') return t('settingsKernel.k1j01nol', [k.error || t('settingsKernel.kqhkhc5')])
  if (!k.installed) return t('settingsKernel.k5d38o5', [k.sizeHint ? ` · ${kernelSizeHint(k.sizeHint)}` : ''])
  const update =
    k.latestVersion && k.version && k.latestVersion !== k.version ? t('settingsKernel.k1fp47s2', [k.latestVersion]) : ''
  return t('settingsKernel.k1rmpemq', [k.version ?? t('settingsKernel.k1of6158'), update])
}
const hasUpdate = (k: api.Kernel) => k.installed && !!k.latestVersion && !!k.version && k.latestVersion !== k.version
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsKernel.kuhnvng')" :sub="$t('settingsKernel.k18kzs9d')">
      <button type="button" class="kbtn" :disabled="loading" @click="load()">{{ $t('settingsKernel.kfk0ip6') }}</button>
    </PageTopbar>

    <div class="doc">
      <div class="doc-inner">
        <ServerFeatureNote feature="kernels" />
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsKernel.kzd3a55') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsKernel.k1w8z972') }}
              </div>
            </div>
          </div>

          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load()" />
          <StateBlock
            v-else-if="!kernels.length"
            state="empty"
            :title="$t('settingsKernel.k16ha1rz')"
            :message="$t('settingsKernel.k139gtnz')"
            compact
          />

          <div v-else>
            <div v-for="k in kernels" :key="k.id" class="row-item krow" :class="{ builtin: k.id === 'builtin' }">
              <span
                v-if="kernelIcon(k)"
                class="kicon"
                :class="kernelIcon(k)!.tile ? 'logo' : 'avatar'"
                :data-kernel-icon="k.id"
                aria-hidden="true"
                ><img :src="kernelIcon(k)!.src" alt=""
              /></span>
              <InitialBadge v-else :name="k.name" :size="38" square />
              <div class="grow">
                <div class="t">
                  {{ kernelName(k) }}
                  <span v-if="k.id === 'builtin'" class="badge-on run">{{ $t('setx.running') }}</span>
                  <span v-else-if="k.status === 'error'" class="badge-bad">{{ $t('settingsKernel.k1nhgkqe') }}</span>
                  <span v-else-if="k.installed" class="badge-on">{{ $t('settingsKernel.k1tcp0lz') }}</span>
                </div>
                <div class="d">
                  {{ k.vendor
                  }}<template v-if="k.npmPackage">
                    · <span class="code">{{ k.npmPackage }}</span></template
                  >
                  <template v-if="k.description"> · {{ kernelDescription(k) }}</template>
                </div>
                <div class="d" :class="{ err: k.status === 'error' }">{{ statusText(k) }}</div>
                <div v-if="busy(k)" class="kprog" :aria-label="$t('settingsKernel.kx4t5kz', [k.progress ?? 0])">
                  <div class="progress-bar"><i :style="{ width: `${k.progress ?? 5}%` }"></i></div>
                  <span>{{ k.progress != null ? `${k.progress}%` : '' }}</span>
                </div>
                <div v-if="k.modeSettingKey && k.mode && k.installed" class="kmode" data-testid="kernel-mode">
                  <div
                    class="segmented sm"
                    role="radiogroup"
                    :aria-label="$t('settingsKernel.k11jacw4', [kernelName(k)])"
                  >
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="k.mode === 'scoped'"
                      :class="{ on: k.mode === 'scoped' }"
                      :disabled="modeSaving[k.id] || !can('settings:write')"
                      :title="can('settings:write') ? '' : denyReason('settings:write')"
                      @click="setMode(k, 'scoped')"
                    >
                      {{ $t('settingsKernel.kivid8z') }}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="k.mode === 'global'"
                      :class="{ on: k.mode === 'global' }"
                      :disabled="modeSaving[k.id] || !can('settings:write')"
                      :title="can('settings:write') ? '' : denyReason('settings:write')"
                      @click="setMode(k, 'global')"
                    >
                      {{ $t('settingsKernel.k1j3dt5s') }}
                    </button>
                  </div>
                  <template v-if="k.mode === 'scoped'">
                    <div v-if="k.scopedProvider" class="kmode-line">
                      <span class="muted">{{ $t('settingsKernel.k19bfcke') }}</span>
                      <select
                        v-if="canChangeModel && modelChoices.length > 1"
                        class="select kmodel"
                        :aria-label="$t('settingsKernel.kh0vx4v', [kernelName(k)])"
                        :value="`${k.scopedProvider.id}::${k.scopedProvider.model}`"
                        @change="setScopedModel(($event.target as HTMLSelectElement).value)"
                      >
                        <option v-for="c in modelChoices" :key="c.value" :value="c.value">{{ c.label }}</option>
                      </select>
                      <b v-else class="kmodel-text" :title="`${k.scopedProvider.name} / ${k.scopedProvider.model}`"
                        >{{ k.scopedProvider.name }} / {{ k.scopedProvider.model }}</b
                      >
                    </div>
                    <div v-else class="note warn login">
                      {{ $t('kernel.reasonNeedModel') }}{{ $t('fmt.period') }}
                      <RouterLink class="link" to="/settings/models">{{ $t('settingsKernel.k1opxiuk') }}</RouterLink>
                    </div>
                    <div class="d">
                      {{ $t('settingsKernel.kjdtk08') }}
                    </div>
                  </template>
                </div>
                <div v-if="k.installed && k.requiresLogin" class="note warn login">
                  {{ $t('settingsKernel.k6hfmvb', [k.loginHint || $t('settingsKernel.k1uny894')]) }}
                </div>
              </div>
              <div class="panel-actions acts">
                <template v-if="k.id !== 'builtin'">
                  <button
                    v-if="!k.installed"
                    type="button"
                    class="kbtn primary kinstall"
                    :disabled="busy(k) || pending[k.id]"
                    @click="run(k, 'install')"
                  >
                    {{ k.status === 'error' ? $t('settingsKernel.k11o09pp') : $t('setx.downloadInstall') }}
                  </button>
                  <template v-else>
                    <button
                      type="button"
                      class="kbtn sm"
                      :class="{ primary: hasUpdate(k) }"
                      :disabled="busy(k) || pending[k.id]"
                      @click="run(k, 'update')"
                    >
                      {{ hasUpdate(k) ? $t('settingsKernel.k1og3iz4') : $t('settingsKernel.k4yjm54') }}
                    </button>
                    <button
                      type="button"
                      class="kbtn sm danger"
                      :disabled="busy(k) || pending[k.id]"
                      @click="run(k, 'uninstall')"
                    >
                      {{ $t('settingsKernel.k8w56qd') }}
                    </button>
                  </template>
                </template>
                <button type="button" class="kbtn sm" @click="openLog(k)">{{ $t('settingsKernel.k1fdb0x9') }}</button>
              </div>
            </div>
          </div>
        </section>

        <!-- 运行限制：无输出超时 / 单次运行总时长；0 明确显示“不限制” -->
        <section class="panel" data-testid="kernel-run-limits">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsKernel.runtimeLimits') }}</h2>
              <div class="panel-sub">{{ $t('settingsKernel.runtimeLimitsSub') }}</div>
            </div>
          </div>
          <form class="limits-form" @submit.prevent="saveLimits">
            <div class="limit-row">
              <label class="field limit-field">
                <span class="limit-label">{{ $t('settingsKernel.idleTimeout') }}</span>
                <input
                  v-model="idleDraft"
                  class="input code limit-input"
                  name="kernelIdleTimeoutSeconds"
                  inputmode="numeric"
                  :disabled="!can('settings:write')"
                  :aria-invalid="Boolean(limitsError)"
                  :title="can('settings:write') ? '' : denyReason('settings:write')"
                />
              </label>
              <div class="limit-side">
                <span v-if="idleIsUnlimited" class="badge-on" data-testid="idle-unlimited">{{
                  $t('settingsKernel.limitsUnlimited')
                }}</span>
                <span class="limit-hint">
                  {{ $t('settingsKernel.idleTimeoutHint') }}
                  · {{ $t('settingsKernel.limitsRange', [IDLE_MIN, IDLE_MAX]) }}
                  · {{ $t('settingsKernel.limitsDefault', [idleDefault]) }}
                </span>
              </div>
            </div>
            <div class="limit-row">
              <label class="field limit-field">
                <span class="limit-label">{{ $t('settingsKernel.maxRun') }}</span>
                <input
                  v-model="maxRunDraft"
                  class="input code limit-input"
                  name="kernelMaxRunMinutes"
                  inputmode="numeric"
                  :disabled="!can('settings:write')"
                  :aria-invalid="Boolean(limitsError)"
                  :title="can('settings:write') ? '' : denyReason('settings:write')"
                />
              </label>
              <div class="limit-side">
                <span v-if="maxRunIsUnlimited" class="badge-on" data-testid="maxrun-unlimited">{{
                  $t('settingsKernel.limitsUnlimited')
                }}</span>
                <span class="limit-hint">
                  {{ $t('settingsKernel.maxRunHint') }}
                  · {{ $t('settingsKernel.limitsRange', [MAXRUN_MIN, MAXRUN_MAX]) }}
                  · {{ $t('settingsKernel.limitsDefault', [maxRunDefault]) }}
                </span>
              </div>
            </div>
            <p v-if="limitsError" class="field-error" role="alert" data-testid="limits-error">{{ limitsError }}</p>
            <div class="hstack limits-actions">
              <button
                type="submit"
                class="kbtn primary"
                :disabled="limitsSaving || !limitsDirty || !can('settings:write')"
              >
                {{ limitsSaving ? $t('settingsKernel.limitsSaving') : $t('settingsKernel.limitsSave') }}
              </button>
              <button type="button" class="kbtn" :disabled="!can('settings:write')" @click="resetLimits">
                {{ $t('settingsKernel.limitsReset') }}
              </button>
            </div>
          </form>
        </section>

        <section class="panel" data-testid="kernel-registry">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsKernel.k91yoon') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsKernel.k1xodpzj', [DEFAULT_REGISTRY]) }}
              </div>
            </div>
          </div>
          <form class="registry-form" @submit.prevent="saveRegistry">
            <label class="field registry-field">
              <span class="sr-only">{{ $t('settingsKernel.kt0vke2') }}</span>
              <input
                v-model="registryDraft"
                class="input code"
                name="kernelRegistry"
                :placeholder="DEFAULT_REGISTRY"
                spellcheck="false"
                :disabled="!can('settings:write')"
                :title="can('settings:write') ? '' : denyReason('settings:write')"
              />
            </label>
            <button
              type="submit"
              class="kbtn"
              :disabled="registrySaving || registryDraft.trim() === registrySaved || !can('settings:write')"
            >
              {{ registrySaving ? $t('settingsKernel.k17glvo8') : $t('settingsKernel.k1xlvxln') }}
            </button>
          </form>
          <p v-if="registryError" class="field-error registry-error" role="alert">{{ registryError }}</p>
        </section>

        <p class="legal">
          {{ $t('settingsKernel.k1bhkh65') }}
        </p>
      </div>
    </div>

    <UiModal
      v-if="logKernel"
      :title="$t('settingsKernel.k1rnxk8v', [kernelName(logKernel)])"
      :subtitle="$t('settingsKernel.kq5prly')"
      :width="720"
      @close="closeLog"
    >
      <StateBlock v-if="logLoading" state="loading" compact />
      <StateBlock v-else-if="logError" state="error" :message="logError" compact @retry="loadLog" />
      <StateBlock v-else-if="!logLines.length" state="empty" :title="$t('settingsKernel.kivgwaf')" compact />
      <pre v-else ref="logBox" class="log-box">{{ logLines.join('\n') }}</pre>
      <template #footer>
        <button type="button" class="kbtn" @click="loadLog">{{ $t('settingsKernel.kfk0ip6') }}</button>
        <button type="button" class="kbtn primary" @click="closeLog">{{ $t('settingsKernel.ktzla4f') }}</button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.kmode {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.kmode .segmented {
  flex-wrap: wrap;
  border-radius: 12px;
}
.segmented.sm button {
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
}
.kmode-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  max-width: 100%;
  min-width: 0;
}
.kmodel {
  width: auto;
  max-width: min(420px, 100%);
  height: 30px;
}
.kmodel-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link {
  text-decoration: underline;
}
.krow {
  align-items: flex-start;
}
.krow.builtin {
  background: var(--surface-soft);
}
.kicon {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-muted);
  display: grid;
  place-items: center;
}
.kicon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 角色头像（png）：和会话里的内核头像一样直接显示，不加底色方块 */
.kicon.avatar {
  background: none;
  border-radius: 0;
  overflow: visible;
}
.kicon.avatar img {
  object-fit: contain;
  filter: drop-shadow(0 1px 2px rgba(17, 17, 19, 0.16));
}
/* 第三方标志是白底描边方块里 24px 的单色图形 */
.kicon.logo {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.kicon.logo img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
:root[data-theme='dark'] .kicon.logo img {
  filter: invert(1);
}
.badge-on.run::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.kinstall {
  height: 32px;
  padding: 0 16px;
}
.acts {
  justify-content: flex-end;
}
.err {
  color: var(--danger);
}
.kprog {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  max-width: 360px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.kprog .progress-bar {
  flex: 1;
}
.login {
  margin-top: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.legal {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0 4px;
}
@media (max-width: 1180px) {
  .krow {
    flex-wrap: wrap;
  }
  .acts {
    width: 100%;
    justify-content: flex-start;
    padding-left: 52px;
  }
}
.registry-form {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 14px 20px 16px;
}
/* 运行限制：左边输入框，右边“不限制”标记 + 说明 */
.limits-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 20px 16px;
}
.limit-row {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.limit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.limit-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.limit-input {
  height: 32px;
  font-variant-numeric: tabular-nums;
}
.limit-side {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  min-width: 0;
}
.limit-hint {
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.7;
}
.limits-actions {
  padding-top: 2px;
}
@media (max-width: 900px) {
  .limit-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
.registry-field {
  flex: 1;
  min-width: 0;
}
.registry-error {
  margin: -6px 20px 14px;
}
</style>
