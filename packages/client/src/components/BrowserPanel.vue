<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { queueBrowserCapture } from '../lib/browser-capture'
import { desktopBrowser } from '../lib/window'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{ close: [] }>()

const bridge = desktopBrowser
const state = ref<LuluxBrowserState | null>(null)
const address = ref('')
const viewport = ref<HTMLElement | null>(null)
const addressInput = ref<HTMLInputElement | null>(null)

let stopState: (() => void) | undefined
let observer: ResizeObserver | null = null
let frame = 0

const tabs = computed(() => state.value?.tabs ?? [])
const activeTab = computed(() => tabs.value.find((tab) => tab.id === state.value?.activeTabId) ?? null)
const loading = computed(() => activeTab.value?.loading ?? false)
const displayUrl = computed(() => (activeTab.value && /^https?:/i.test(activeTab.value.url) ? activeTab.value.url : ''))

function applyState(next: LuluxBrowserState | null): void {
  state.value = next
  const tab = next?.tabs.find((item) => item.id === next.activeTabId)
  if (!tab) {
    if (!address.value) address.value = ''
    return
  }
  if (document.activeElement !== addressInput.value) {
    address.value = /^https?:/i.test(tab.url) ? tab.url : ''
  }
}

function syncBounds(): void {
  const element = viewport.value
  if (!element || !bridge) return
  const rect = element.getBoundingClientRect()
  bridge.setBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  })
}

function scheduleSync(): void {
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = 0
    syncBounds()
  })
}

function submitAddress(): void {
  if (!bridge) return
  const value = address.value.trim()
  if (!value) return
  bridge.navigate(value)
  addressInput.value?.blur()
}

function focusAddress(): void {
  addressInput.value?.select()
}

function openNewTab(): void {
  void bridge?.newTab()
}

function closeTab(id: string, event: MouseEvent): void {
  event.stopPropagation()
  void bridge?.closeTab(id)
}

function activateTab(id: string): void {
  void bridge?.activateTab(id)
}

/* ── 框选 / 元素：在网页上拾取，截图 + 页面信息送进会话输入框（旧版桌面端没有 pick 时不显示） ── */
type PickMode = 'region' | 'element'
const canPick = computed(() => typeof bridge?.pick === 'function')
const picking = ref<PickMode | null>(null)
let pickToken = 0

async function startPick(mode: PickMode): Promise<void> {
  if (!bridge?.pick) return
  const previous = picking.value
  if (previous) {
    // 再点一次同一个按钮 = 取消；点另一个 = 切换模式（网页里的旧覆盖层会被新的替换）
    void bridge.cancelPick?.()
    if (previous === mode) {
      picking.value = null
      return
    }
  }
  const token = ++pickToken
  picking.value = mode
  try {
    const result = await bridge.pick(mode)
    if (token !== pickToken) return
    if (result) {
      queueBrowserCapture(result)
      toast.success(t('browserPanel.pickAdded'))
    }
  } catch (error) {
    if (token === pickToken) toast.error(t('browserPanel.pickFailed', [errorText(error)]))
  } finally {
    if (token === pickToken) picking.value = null
  }
}

function cancelPick(): void {
  if (!picking.value) return
  pickToken += 1
  picking.value = null
  void bridge?.cancelPick?.()
}

function onWindowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && picking.value) {
    event.preventDefault()
    cancelPick()
  }
}

function openExternal(): void {
  const url = displayUrl.value
  if (url) void bridge?.openExternal(url)
}

watch(
  () => activeTab.value?.id,
  () => {
    cancelPick()
    scheduleSync()
    const url = activeTab.value?.url ?? ''
    if (document.activeElement !== addressInput.value) {
      address.value = /^https?:/i.test(url) ? url : ''
    }
  },
)

onMounted(async () => {
  if (!bridge) return
  stopState = bridge.onState(applyState)
  const initial = await bridge.getState()
  applyState(initial)
  if (!initial || initial.tabs.length === 0) await bridge.newTab()
  await nextTick()
  observer = new ResizeObserver(scheduleSync)
  if (viewport.value) observer.observe(viewport.value)
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('keydown', onWindowKey)
  scheduleSync()
  bridge.setVisible(true)
  scheduleSync()
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  observer?.disconnect()
  observer = null
  window.removeEventListener('resize', scheduleSync)
  window.removeEventListener('keydown', onWindowKey)
  cancelPick()
  bridge?.setVisible(false)
  stopState?.()
  stopState = undefined
})
</script>

<template>
  <aside class="tool-panel browser-panel">
    <header class="tool-panel-header">
      <button
        type="button"
        class="icon-button"
        :title="$t('browserPanel.k5x13zv')"
        :aria-label="$t('browserPanel.k5x13zv')"
        @click="emit('close')"
      >
        <AppIcon name="chevron-left" :size="18" />
      </button>
      <div class="tool-panel-heading">
        <strong>{{ $t('browserPanel.k11yttjx') }}</strong>
        <span>{{ $t('browserPanel.k1pmiju3') }}</span>
      </div>
      <button
        v-if="bridge"
        type="button"
        class="icon-button"
        :title="$t('browserPanel.ky7b5cb')"
        :aria-label="$t('browserPanel.ky7b5cb')"
        @click="openNewTab"
      >
        <AppIcon name="plus" :size="17" />
      </button>
    </header>

    <template v-if="bridge">
      <div class="browser-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="browser-tab"
          :class="{ active: tab.id === state?.activeTabId }"
          @click="activateTab(tab.id)"
        >
          <span v-if="tab.loading" class="browser-tab-spinner" />
          <AppIcon v-else name="globe" :size="13" />
          <span class="browser-tab-title">{{ tab.title || $t('browserPanel.k18hdhvq') }}</span>
          <span
            class="browser-tab-close"
            role="button"
            :title="$t('browserPanel.kvc1vit')"
            @click="closeTab(tab.id, $event)"
          >
            <AppIcon name="close" :size="11" />
          </span>
        </button>
        <button
          type="button"
          class="browser-tab-add"
          :title="$t('browserPanel.ky7b5cb')"
          :aria-label="$t('browserPanel.ky7b5cb')"
          @click="openNewTab"
        >
          <AppIcon name="plus" :size="14" />
        </button>
      </div>

      <div class="browser-toolbar">
        <button
          type="button"
          class="icon-button"
          :title="$t('browserPanel.klcoxsq')"
          :aria-label="$t('browserPanel.klcoxsq')"
          :disabled="!activeTab?.canGoBack"
          @click="bridge?.back()"
        >
          <AppIcon name="chevron-left" :size="17" />
        </button>
        <button
          type="button"
          class="icon-button"
          :title="$t('browserPanel.kdw260f')"
          :aria-label="$t('browserPanel.kdw260f')"
          :disabled="!activeTab?.canGoForward"
          @click="bridge?.forward()"
        >
          <AppIcon name="chevron-right" :size="17" />
        </button>
        <button
          type="button"
          class="icon-button"
          :title="loading ? $t('browserPanel.k1izmnob') : $t('browserPanel.kfk0ip6')"
          @click="bridge?.reload()"
        >
          <AppIcon :name="loading ? 'close' : 'refresh'" :size="16" />
        </button>

        <label class="browser-address">
          <AppIcon name="globe" :size="14" class="browser-address-icon" />
          <input
            ref="addressInput"
            v-model="address"
            type="text"
            :placeholder="$t('browserPanel.kq2txro')"
            spellcheck="false"
            autocomplete="off"
            @focus="focusAddress"
            @keydown.enter.prevent="submitAddress"
          />
        </label>

        <template v-if="canPick">
          <button
            type="button"
            class="browser-pick"
            :class="{ active: picking === 'region' }"
            :title="picking === 'region' ? $t('browserPanel.pickingRegion') : $t('browserPanel.pickRegionHint')"
            :aria-pressed="picking === 'region'"
            data-testid="browser-pick-region"
            @click="startPick('region')"
          >
            <AppIcon name="crop" :size="15" />
            <span>{{ $t('browserPanel.pickRegion') }}</span>
          </button>
          <button
            type="button"
            class="browser-pick"
            :class="{ active: picking === 'element' }"
            :title="picking === 'element' ? $t('browserPanel.pickingElement') : $t('browserPanel.pickElementHint')"
            :aria-pressed="picking === 'element'"
            data-testid="browser-pick-element"
            @click="startPick('element')"
          >
            <AppIcon name="cursor" :size="15" />
            <span>{{ $t('browserPanel.pickElement') }}</span>
          </button>
        </template>

        <button
          type="button"
          class="icon-button"
          :title="$t('browserPanel.k12lk4n0')"
          :aria-label="$t('browserPanel.k12lk4n0')"
          :disabled="!displayUrl"
          @click="openExternal"
        >
          <AppIcon name="external" :size="16" />
        </button>
      </div>

      <div ref="viewport" class="browser-viewport" />
    </template>

    <div v-else class="browser-fallback">
      <span class="browser-fallback-icon"><AppIcon name="globe" :size="26" /></span>
      <strong>{{ $t('browserPanel.k8okhnz') }}</strong>
      <p>
        {{ $t('browserPanel.k36u1q7') }}
      </p>
      <code>npm run dev:desktop</code>
    </div>
  </aside>
</template>
