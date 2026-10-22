<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  EFFORT_LEVELS,
  effectiveEffort,
  effortLabel,
  effortModeOf,
  selectedOption,
  shortModel,
  type EffortLevel,
  type ModelOption,
} from '../lib/models'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import { can } from '../lib/session'
import AppIcon from './AppIcon.vue'
import UiSwitch from './ui/UiSwitch.vue'

/**
 * 输入框右侧的模型 / 推理强度选择器（契约 §6.13）：胶囊显示“模型名 强度 ⌄”，
 * 弹层里是“更快 ↔ 更聪明”的五档滑块（关闭 / 低 / 中 / 高 / 极高，模型不支持的档置灰）
 * 和一行“当前模型名 ›”，点开二级菜单按 Provider（或 CLI）分组列出模型，“默认”永远在第一个。
 * 滑块是粗胶囊轨道 + 档位小圆点 + 白色圆角方块拇指，已选部分是蓝→深海军蓝→近黑的流动渐变；
 * 点击 / 拖动 / 方向键都吸附到档位（不支持的档跳过）。
 * 按会话保存；群聊里只作用于 LULUX 内置成员。
 * 只能开 / 关思考的模型显示开关；始终思考的模型只显示说明；没识别到支持时给出去 Provider 设置的入口。
 */
const store = useAppStore()
const router = useRouter()
const MENU_WIDTH = 260
const SUB_WIDTH = 240
/** 拇指半宽 = 轨道半高：两端档位离轨道边缘的距离 */
const THUMB_HALF = 11

const open = ref(false)
const subOpen = ref(false)
const busy = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const sub = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })
const subPos = ref({ left: 0, top: 0, maxHeight: 360 })

const kernel = computed(() => store.currentModelKernel)
const catalog = computed(() => store.modelCatalogs[kernel.value] ?? null)
const choice = computed(() => store.currentModelChoice)
const option = computed(() => selectedOption(catalog.value, choice.value))
const stored = computed(() => store.currentEffortSetting)
const effort = computed(() => effectiveEffort(catalog.value, option.value, stored.value))
const mode = computed(() => effortModeOf(option.value))
/** 选中模型可分档调节（开关风格不显示滑块） */
const adjustable = computed(() => mode.value === 'graded')
const thinkingOn = computed(() => Boolean(effort.value && effort.value !== 'off'))
/** 没识别到支持时：Provider 模型可以去设置里手动开启 */
const configurable = computed(() => mode.value === 'none' && Boolean(option.value?.providerId) && catalog.value?.mode !== 'global')
const canConfigure = computed(() => can('providers:write'))
const showSlider = computed(() => Boolean(catalog.value?.effort))
const readOnlySession = computed(() => Boolean(store.currentSession?.workflowRunId))
const canManage = computed(() => {
  const role = store.currentSession?.myRole
  return !role || role === 'owner' || role === 'admin'
})

const modelText = computed(() => {
  const o = option.value
  if (!o) return t('modelPicker.default')
  if (o.model === null && catalog.value?.mode === 'global') return t('modelPicker.default')
  return shortModel(o.label) || t('modelPicker.default')
})
const effortText = computed(() => {
  if (!showSlider.value || !effort.value) return ''
  if (mode.value === 'toggle') return thinkingOn.value ? t('modelPicker.thinkingOn') : ''
  return adjustable.value ? effortLabel(effort.value) : ''
})
const triggerTitle = computed(() =>
  effortText.value
    ? t('modelPicker.triggerAria', [modelText.value, effortText.value])
    : t('modelPicker.triggerAriaModel', [modelText.value]),
)
/** 默认档（恢复默认时显示） */
const defaultEffortText = computed(() => {
  const d = catalog.value?.defaultEffort
  return d ? effortLabel(d) : t('modelPicker.cliDefault')
})
/** 拖动中的档（松手才保存） */
const dragLevel = ref<EffortLevel | null>(null)
const shownEffort = computed(() => (adjustable.value ? (dragLevel.value ?? effort.value) : null))
/** 已选部分占比（0–1）：不可调时为 0（拇指停在第一档） */
const fillRatio = computed(() => {
  const level = shownEffort.value
  if (!level) return 0
  return EFFORT_LEVELS.indexOf(level) / (EFFORT_LEVELS.length - 1)
})
const multiGroup = computed(() => (catalog.value?.groups ?? []).filter((g) => g.options.length).length > 1)
/** 档位在轨道里的水平位置（两端各留半个拇指的空间） */
function stopLeft(ratio: number): string {
  return `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${ratio})`
}

watch(
  kernel,
  (value) => {
    if (value) void store.loadModels(value)
  },
  { immediate: true },
)

function supported(level: EffortLevel): boolean {
  return Boolean(option.value?.efforts.includes(level))
}

async function toggle(): Promise<void> {
  if (open.value) {
    close()
    return
  }
  open.value = true
  subOpen.value = false
  // Provider / 内核模式可能刚在设置里改过：每次打开都刷新一次
  void store.loadModels(kernel.value, true)
  await nextTick()
  place()
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', place)
  menu.value?.querySelector<HTMLButtonElement>('.mp-stop.on, .mp-model-row')?.focus()
}

function place(): void {
  const rect = trigger.value?.getBoundingClientRect()
  const height = menu.value?.offsetHeight ?? 220
  if (!rect) return
  pos.value = {
    left: Math.max(12, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 12)),
    top: Math.max(12, rect.top - height - 8),
  }
  if (subOpen.value) placeSub()
}

function placeSub(): void {
  const row = menu.value?.querySelector<HTMLElement>('.mp-model-row')?.getBoundingClientRect()
  if (!row) return
  // 优先开在弹层右边（与参考一致）；右边放不下（胶囊在窗口右侧时）再开左边
  const rightSide = pos.value.left + MENU_WIDTH + 6
  const left =
    rightSide + SUB_WIDTH <= window.innerWidth - 12 ? rightSide : Math.max(12, pos.value.left - SUB_WIDTH - 6)
  const maxHeight = Math.max(200, Math.min(420, window.innerHeight - 24))
  const height = Math.min(sub.value?.offsetHeight ?? 300, maxHeight)
  // 顶部与“模型”行对齐，底部放不下就整体上移
  const top = Math.max(12, Math.min(row.top - 6, window.innerHeight - height - 12))
  subPos.value = { left, top, maxHeight }
}

async function toggleSub(): Promise<void> {
  subOpen.value = !subOpen.value
  if (!subOpen.value) return
  await nextTick()
  placeSub()
  await nextTick()
  placeSub()
  sub.value?.querySelector<HTMLButtonElement>('.mp-option.checked, .mp-option')?.focus()
}

function close(): void {
  open.value = false
  subOpen.value = false
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', place)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (subOpen.value) {
      subOpen.value = false
      menu.value?.querySelector<HTMLButtonElement>('.mp-model-row')?.focus()
      return
    }
    close()
    trigger.value?.focus()
    return
  }
  const active = document.activeElement as HTMLElement | null
  if (active?.classList.contains('mp-stop') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    const stops = EFFORT_LEVELS.filter(supported)
    const current = effort.value ? stops.indexOf(effort.value) : -1
    const next = stops[Math.max(0, Math.min(stops.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))]
    if (next) void pickEffort(next, true)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const scope = subOpen.value ? sub.value : menu.value
    const items = Array.from(scope?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(active as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next].focus()
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', place)
})

/** 指针位置 → 最近的、模型支持的档 */
function levelAt(clientX: number, el: HTMLElement): EffortLevel | null {
  const rect = el.getBoundingClientRect()
  const usable = rect.width - THUMB_HALF * 2
  if (usable <= 0) return null
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left - THUMB_HALF) / usable))
  let best: EffortLevel | null = null
  let bestDist = Infinity
  EFFORT_LEVELS.forEach((level, i) => {
    if (!supported(level)) return
    const dist = Math.abs(i / (EFFORT_LEVELS.length - 1) - ratio)
    if (dist < bestDist) {
      bestDist = dist
      best = level
    }
  })
  return best
}

function onPointerDown(event: PointerEvent): void {
  if (!adjustable.value || busy.value || event.button !== 0) return
  const el = event.currentTarget as HTMLElement
  dragLevel.value = levelAt(event.clientX, el)
  el.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (dragLevel.value === null) return
  const next = levelAt(event.clientX, event.currentTarget as HTMLElement)
  if (next) dragLevel.value = next
}

function onPointerUp(event: PointerEvent): void {
  const level = dragLevel.value
  if (level === null) return
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  void pickEffort(level, true).finally(() => {
    dragLevel.value = null
  })
}

function onPointerCancel(): void {
  dragLevel.value = null
}

async function pickEffort(level: EffortLevel | null, keepFocus = false): Promise<void> {
  if (busy.value) return
  if (level && !supported(level)) return
  if (level === stored.value) return
  busy.value = true
  try {
    await store.setReasoningEffort(level)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
  if (keepFocus) {
    await nextTick()
    menu.value?.querySelector<HTMLButtonElement>('.mp-stop.on')?.focus()
  }
}

/** 去“模型与密钥”里这个模型的思考强度设置 */
function openModelSettings(): void {
  const o = option.value
  if (!o?.providerId) return
  close()
  void router.push({ path: '/settings/models', query: { provider: o.providerId, model: o.model ?? o.label, focus: 'reasoning' } })
}

async function pickModel(target: ModelOption | null): Promise<void> {
  if (busy.value) return
  const next = { providerId: target?.providerId ?? null, model: target?.model ?? null }
  close()
  if (next.model === choice.value.model && (next.model === null || next.providerId === option.value?.providerId)) return
  busy.value = true
  try {
    await store.setModelChoice(next)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}

/** 默认项：会话没选模型（或选的已不在列表里）；其他项：就是会话选的那个 */
function isChecked(target: ModelOption | null): boolean {
  if (!target) return !choice.value.model || option.value === catalog.value?.default
  return Boolean(choice.value.model) && option.value === target
}
</script>

<template>
  <div class="mp-picker">
    <button
      ref="trigger"
      type="button"
      class="mp-trigger"
      data-testid="model-picker"
      :data-model="choice.model ?? ''"
      :data-effort="effort ?? ''"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-label="triggerTitle"
      :title="triggerTitle"
      :disabled="busy || readOnlySession || !canManage"
      @click="toggle"
    >
      <span class="mp-trigger-model">{{ modelText }}</span>
      <span v-if="effortText" class="mp-trigger-effort">{{ effortText }}</span>
      <AppIcon name="chevron-down" :size="14" class="mp-trigger-chevron" />
    </button>
    <Teleport to="body">
      <div v-if="open" class="kernel-backdrop" @mousedown.self="close">
        <div
          ref="menu"
          class="kernel-menu mp-menu"
          role="dialog"
          :aria-label="$t('modelPicker.title')"
          data-testid="model-menu"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${MENU_WIDTH}px` }"
        >
          <template v-if="showSlider && mode === 'toggle'">
            <div class="mp-toggle" data-testid="effort-toggle">
              <span class="mp-toggle-text">
                <strong>{{ $t('modelPicker.thinking') }}</strong>
                <span>{{ $t('modelPicker.toggleHint') }}</span>
              </span>
              <UiSwitch
                :model-value="thinkingOn"
                :label="$t('modelPicker.thinking')"
                :disabled="busy"
                @update:model-value="pickEffort($event ? 'high' : 'off')"
              />
            </div>
            <button
              v-if="stored !== null"
              type="button"
              class="mp-reset"
              data-testid="effort-reset"
              @click="pickEffort(null)"
            >
              {{ $t('modelPicker.resetEffort', [defaultEffortText]) }}
            </button>
            <div class="mp-sep" />
          </template>
          <template v-else-if="showSlider && mode === 'fixed'">
            <p class="mp-note" data-testid="effort-fixed">{{ $t('modelPicker.alwaysThinks') }}</p>
            <div class="mp-sep" />
          </template>
          <template v-else-if="showSlider">
            <div class="mp-ends" aria-hidden="true">
              <span>{{ $t('modelPicker.faster') }}</span>
              <span>{{ $t('modelPicker.smarter') }}</span>
            </div>
            <div
              class="mp-slider"
              :class="{ dim: !adjustable, dragging: dragLevel !== null }"
              role="radiogroup"
              :aria-label="$t('modelPicker.effortTitle')"
              :title="shownEffort ? effortLabel(shownEffort) : $t('modelPicker.noEffort')"
              data-testid="effort-slider"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerCancel"
            >
              <div class="mp-track" aria-hidden="true">
                <div
                  class="mp-fill"
                  :style="{
                    clipPath: `inset(0 calc((100% - ${THUMB_HALF * 2}px) * ${1 - fillRatio}) 0 0 round ${THUMB_HALF}px)`,
                  }"
                />
              </div>
              <button
                v-for="(level, i) in EFFORT_LEVELS"
                :key="level"
                type="button"
                role="radio"
                class="mp-stop"
                :class="{
                  on: adjustable && level === effort,
                  passed: shownEffort !== null && i <= EFFORT_LEVELS.indexOf(shownEffort),
                }"
                :style="{ left: stopLeft(i / (EFFORT_LEVELS.length - 1)) }"
                :aria-checked="adjustable && level === effort"
                :aria-label="effortLabel(level)"
                :title="supported(level) ? effortLabel(level) : $t('modelPicker.unsupported', [effortLabel(level)])"
                :disabled="!supported(level) || busy"
                :data-level="level"
                :tabindex="adjustable && level === effort ? 0 : -1"
                @click="pickEffort(level)"
              >
                <span class="mp-dot" />
              </button>
              <span class="mp-thumb" aria-hidden="true" :style="{ left: stopLeft(fillRatio) }" />
            </div>
            <div class="mp-stop-labels" aria-hidden="true">
              <span
                v-for="(level, i) in EFFORT_LEVELS"
                :key="level"
                :class="{ on: shownEffort === level, off: !supported(level) }"
                :style="{ left: stopLeft(i / (EFFORT_LEVELS.length - 1)) }"
                >{{ effortLabel(level) }}</span
              >
            </div>
            <p v-if="!adjustable" class="mp-note" data-testid="effort-unsupported">
              <template v-if="configurable && canConfigure">
                {{ $t('modelPicker.notDetected') }} ·
                <button type="button" class="mp-link" data-testid="effort-configure" @click="openModelSettings">
                  {{ $t('modelPicker.goSettings') }}
                </button>
              </template>
              <template v-else-if="configurable">{{ $t('modelPicker.notDetectedAskAdmin') }}</template>
              <template v-else>{{ $t('modelPicker.noEffort') }}</template>
            </p>
            <button
              v-else-if="stored !== null"
              type="button"
              class="mp-reset"
              data-testid="effort-reset"
              @click="pickEffort(null)"
            >
              {{ $t('modelPicker.resetEffort', [defaultEffortText]) }}
            </button>
            <div class="mp-sep" />
          </template>
          <button
            type="button"
            class="kernel-row mp-model-row"
            :class="{ active: subOpen }"
            aria-haspopup="menu"
            :aria-expanded="subOpen"
            :aria-label="$t('fmt.labelled', [$t('modelPicker.model'), modelText])"
            data-testid="model-row"
            @click="toggleSub"
          >
            <span class="mp-row-value">{{ modelText }}</span>
            <AppIcon name="chevron-right" :size="15" class="mp-row-chevron" />
          </button>
          <p v-if="store.isGroupChat" class="mp-foot" data-testid="model-group-note">
            {{ $t('modelPicker.groupNote') }}
          </p>
          <p v-else-if="catalog?.mode === 'global'" class="mp-foot">
            {{ $t('modelPicker.cliNote', [catalog.kernelName]) }}
          </p>
        </div>
        <div
          v-if="subOpen"
          ref="sub"
          class="kernel-menu mp-sub"
          role="menu"
          :aria-label="$t('modelPicker.model')"
          data-testid="model-submenu"
          :style="{
            left: `${subPos.left}px`,
            top: `${subPos.top}px`,
            width: `${SUB_WIDTH}px`,
            maxHeight: `${subPos.maxHeight}px`,
          }"
        >
          <p class="mp-sub-title">{{ $t('modelPicker.model') }}</p>
          <button
            type="button"
            role="menuitemradio"
            class="mp-option"
            :class="{ checked: isChecked(null) }"
            :aria-checked="isChecked(null)"
            data-model=""
            @click="pickModel(null)"
          >
            <span class="mp-option-text">
              <strong class="mp-option-name">{{ $t('modelPicker.default') }}</strong>
              <span v-if="catalog?.mode !== 'global' && catalog?.default.label" class="mp-option-hint">{{
                catalog.default.label
              }}</span>
              <span v-else class="mp-option-hint">{{ $t('modelPicker.cliDefaultDesc') }}</span>
            </span>
            <AppIcon v-if="isChecked(null)" name="check" :size="15" class="mp-check" />
          </button>
          <template v-for="group in catalog?.groups ?? []" :key="group.id">
            <p v-if="group.options.length && multiGroup" class="mp-group" :title="group.label">{{ group.label }}</p>
            <button
              v-for="item in group.options"
              :key="`${group.id}::${item.model}`"
              type="button"
              role="menuitemradio"
              class="mp-option"
              :class="{ checked: isChecked(item) }"
              :aria-checked="isChecked(item)"
              :data-model="item.model"
              :title="item.label"
              @click="pickModel(item)"
            >
              <span class="mp-option-text">
                <strong class="mp-option-name">{{ item.label }}</strong>
              </span>
              <AppIcon v-if="isChecked(item)" name="check" :size="15" class="mp-check" />
            </button>
          </template>
          <p v-if="!catalog" class="mp-foot">{{ $t('modelPicker.loading') }}</p>
          <p v-else-if="!catalog.groups.some((g) => g.options.length)" class="mp-foot">
            {{
              catalog.mode === 'global'
                ? $t('modelPicker.cliOnlyDefault', [catalog.kernelName])
                : $t('modelPicker.noModels')
            }}
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mp-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 2px 6px;
}
.mp-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 12.5px;
}
.mp-toggle-text span {
  color: var(--text-tertiary);
  font-size: 11.5px;
}
.mp-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--info-text);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.mp-picker {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
}
/* 胶囊：没有底色，只有“模型名（深）强度（灰）⌄” */
.mp-trigger {
  height: 38px;
  max-width: 240px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13.5px;
  white-space: nowrap;
  transition: color 0.12s ease;
}
.mp-trigger:hover:not(:disabled),
.mp-trigger[aria-expanded='true'] {
  color: var(--text-secondary);
}
.mp-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.mp-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.mp-trigger-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-weight: 500;
}
.mp-trigger-effort {
  flex: 0 0 auto;
}
.mp-trigger-chevron {
  flex: 0 0 auto;
  margin-left: -1px;
}
/* 输入框较窄（右侧详情面板打开等）：模型名收窄，强度文字隐藏 */
@container composer (max-width: 560px) {
  .mp-trigger {
    max-width: 128px;
    padding: 0 6px;
  }
  .mp-trigger-effort {
    display: none;
  }
}
@container composer (max-width: 420px) {
  .mp-trigger {
    max-width: 92px;
  }
}

/* 弹层与二级菜单：白卡片、细边、柔和阴影 */
.mp-menu,
.mp-sub {
  gap: 0;
  border-radius: 14px;
  background: var(--surface);
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 12px 32px rgba(17, 17, 19, 0.1),
    0 2px 6px rgba(17, 17, 19, 0.04);
}
:global(:root[data-theme='dark']) .mp-menu,
:global(:root[data-theme='dark']) .mp-sub {
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 14px 36px rgba(0, 0, 0, 0.5);
}
.mp-menu {
  --mp-track: #ececef;
  --mp-dot-off: #c2c2c8;
  padding: 12px 8px 6px;
}
:global(:root[data-theme='dark']) .mp-menu {
  --mp-track: #2e2e34;
  --mp-dot-off: #5a5a62;
}
.mp-ends {
  display: flex;
  justify-content: space-between;
  margin: 0 8px 8px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1;
}

/* ---- 滑块：粗胶囊轨道 + 圆点 + 圆角方块拇指 ---- */
.mp-slider {
  position: relative;
  height: 22px;
  margin: 0 8px;
  touch-action: none;
  cursor: pointer;
}
.mp-slider.dim {
  cursor: default;
}
.mp-track {
  position: absolute;
  inset: 0;
  border-radius: 11px;
  background: var(--mp-track);
  overflow: hidden;
}
/* 已选部分：整条轨道宽的渐变，用 clip-path 裁到拇指处（渐变不随长度挤压），叠一道流动高光 */
.mp-fill {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(100deg, transparent 0%, rgba(191, 219, 254, 0.42) 50%, transparent 100%),
    linear-gradient(90deg, #3b82f6 0%, #1e3a8a 58%, #0b0f19 100%);
  background-size:
    38% 100%,
    100% 100%;
  background-repeat: no-repeat;
  background-position:
    -70% 0,
    0 0;
  transition: clip-path 0.22s cubic-bezier(0.3, 0.7, 0.2, 1);
  animation: mp-flow 2.6s linear infinite;
}
@keyframes mp-flow {
  from {
    background-position:
      -70% 0,
      0 0;
  }
  to {
    background-position:
      170% 0,
      0 0;
  }
}
.mp-slider.dim .mp-fill {
  opacity: 0;
}
.mp-slider.dragging .mp-fill,
.mp-slider.dragging .mp-thumb {
  transition-duration: 0.1s;
}
.mp-stop {
  position: absolute;
  top: 50%;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.mp-stop:disabled {
  cursor: not-allowed;
}
.mp-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--mp-dot-off);
  transition:
    background 0.18s ease,
    transform 0.12s ease;
}
.mp-stop.passed .mp-dot {
  background: rgba(255, 255, 255, 0.55);
}
.mp-stop:hover:not(:disabled) .mp-dot {
  transform: scale(1.4);
}
.mp-stop:disabled .mp-dot {
  opacity: 0;
}
.mp-stop:focus-visible {
  outline: none;
}
.mp-thumb {
  position: absolute;
  top: 50%;
  width: 20px;
  height: 18px;
  margin: -9px 0 0 -10px;
  border-radius: 6px;
  background: #fff;
  box-shadow:
    0 0 0 1px rgba(59, 130, 246, 0.45),
    0 0 0 3.5px rgba(59, 130, 246, 0.18),
    0 0 10px rgba(59, 130, 246, 0.35),
    0 1px 2px rgba(11, 15, 25, 0.25);
  pointer-events: none;
  transition: left 0.22s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.mp-slider.dim .mp-thumb {
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 1px 2px rgba(11, 15, 25, 0.18);
}
.mp-slider:has(.mp-stop:focus-visible) .mp-thumb {
  box-shadow:
    0 0 0 1px rgba(59, 130, 246, 0.7),
    0 0 0 4px var(--focus-ring),
    0 0 10px rgba(59, 130, 246, 0.4);
}
/* 档位文字：与档位同一水平位置，居中 */
.mp-stop-labels {
  position: relative;
  height: 14px;
  margin: 7px 8px 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 14px;
}
.mp-stop-labels span {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
  transition: color 0.15s ease;
}
.mp-stop-labels .on {
  color: var(--text);
  font-weight: 500;
}
.mp-stop-labels .off {
  opacity: 0.45;
}
.mp-note {
  margin: 8px 8px 0;
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
}
.mp-reset {
  align-self: flex-end;
  margin: 6px 4px 0;
  padding: 2px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11.5px;
}
.mp-reset:hover {
  color: var(--text);
  text-decoration: underline;
}
.mp-sep {
  height: 1px;
  margin: 10px 8px 4px;
  background: var(--line);
}
.mp-model-row {
  height: 36px;
  gap: 8px;
  padding: 0 8px;
  border-radius: 10px;
  color: var(--text);
  font-size: 13.5px;
}
.mp-model-row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.mp-model-row.active {
  background: var(--surface-hover);
}
.mp-row-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-row-chevron {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}
.mp-foot {
  margin: 4px 8px 4px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
}

/* ---- 二级菜单 ---- */
.mp-sub {
  padding: 6px;
  overflow-y: auto;
  z-index: 81;
}
.mp-sub-title {
  margin: 4px 10px 4px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 20px;
}
.mp-group {
  margin: 8px 10px 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 18px;
}
.mp-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.mp-option:hover,
.mp-option:focus-visible {
  outline: none;
  background: var(--surface-hover);
}
.mp-option-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.mp-option-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 400;
}
.mp-option-hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-tertiary);
  font-size: 12px;
}
.mp-check {
  flex: 0 0 auto;
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  .mp-fill {
    animation: none;
    background-image: linear-gradient(90deg, #3b82f6 0%, #1e3a8a 58%, #0b0f19 100%);
  }
  .mp-fill,
  .mp-thumb,
  .mp-dot {
    transition: none;
  }
}
:global(html.reduce-motion) .mp-fill {
  animation: none;
  background-image: linear-gradient(90deg, #3b82f6 0%, #1e3a8a 58%, #0b0f19 100%);
}
:global(html.reduce-motion) .mp-fill,
:global(html.reduce-motion) .mp-thumb {
  transition: none;
}
</style>
