<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { Agent } from '../../api'
import { kernelReasonText } from '../../lib/kernel'
import { kernelAvatar } from '../../lib/kernel-logos'
import { t } from '../../i18n'

/**
 * 节点卡片里的内核下拉：内核头像 + 名称；未安装 / 不可用的内核置灰、不能选，悬停给原因。
 * 只列 LULUX（builtin）和命令行内核，旧 persona 不列。浮层挂到 body，画布缩放不影响它。
 */
const props = defineProps<{ modelValue: string; agents: Agent[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()

interface KernelOption {
  id: string
  name: string
  kernelId: string
  available: boolean
  reason: string
}

const options = computed<KernelOption[]>(() => {
  const out: KernelOption[] = []
  const builtin = props.agents.find((a) => a.id === 'builtin' || a.kind === 'builtin')
  out.push({
    id: builtin?.id ?? 'builtin',
    name: t('workflow.kernelLulux'),
    kernelId: 'builtin',
    available: builtin?.available !== false,
    reason: kernelReasonText(builtin?.unavailableReason),
  })
  for (const a of props.agents) {
    if (a.kind !== 'kernel' || !a.kernelId) continue
    out.push({
      id: a.id,
      name: a.name,
      kernelId: a.kernelId,
      available: a.available !== false,
      reason: kernelReasonText(a.unavailableReason),
    })
  }
  return out
})

const current = computed<KernelOption>(
  () =>
    options.value.find((o) => o.id === props.modelValue) ?? {
      id: props.modelValue,
      name: props.modelValue || t('workflow.kernelUnknown'),
      kernelId: props.modelValue.replace(/^kernel-/, ''),
      available: false,
      reason: t('workflow.kernelUnknown'),
    },
)

function avatarOf(o: KernelOption): { src: string; tile: boolean } {
  return kernelAvatar(o.kernelId) ?? { src: '/icon.png', tile: false }
}

const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: 220 })

function place(): void {
  const r = trigger.value?.getBoundingClientRect()
  if (!r) return
  const width = Math.max(220, r.width)
  const height = menu.value?.offsetHeight ?? 320
  let top = r.bottom + 4
  if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 4)
  pos.value = { left: Math.min(r.left, window.innerWidth - width - 8), top, width }
}

function onDoc(e: Event): void {
  const target = e.target as Node
  if (menu.value?.contains(target) || trigger.value?.contains(target)) return
  close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
    trigger.value?.focus()
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const items = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next].focus()
  }
}

async function toggle(): Promise<void> {
  if (props.disabled) return
  if (open.value) return close()
  open.value = true
  place()
  await nextTick()
  place()
  document.addEventListener('pointerdown', onDoc, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('wheel', close, { passive: true })
  menu.value?.querySelector<HTMLButtonElement>('button.on, button:not(:disabled)')?.focus()
}
function close(): void {
  open.value = false
  document.removeEventListener('pointerdown', onDoc, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('wheel', close)
}
function pick(o: KernelOption): void {
  if (!o.available) return
  emit('update:modelValue', o.id)
  close()
  trigger.value?.focus()
}
onBeforeUnmount(close)
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="ks-trigger nodrag"
    :class="{ off: !current.available }"
    :disabled="disabled"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-label="$t('workflow.kernel')"
    :title="current.available ? current.name : `${current.name} · ${current.reason}`"
    data-testid="kernel-select"
    @click="toggle"
  >
    <span class="ks-av" :class="{ tile: avatarOf(current).tile }"><img :src="avatarOf(current).src" alt="" /></span>
    <span class="ks-name">{{ current.name }}</span>
    <svg class="ks-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="ks-menu"
      role="listbox"
      :aria-label="$t('workflow.kernel')"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` }"
    >
      <button
        v-for="o in options"
        :key="o.id"
        type="button"
        role="option"
        class="ks-opt"
        :class="{ on: o.id === modelValue }"
        :aria-selected="o.id === modelValue"
        :disabled="!o.available"
        :title="o.available ? o.name : `${o.name} · ${o.reason || $t('workflow.kernelUnavailable')}`"
        :data-kernel="o.kernelId"
        @click="pick(o)"
      >
        <span class="ks-av" :class="{ tile: avatarOf(o).tile }"><img :src="avatarOf(o).src" alt="" /></span>
        <span class="ks-name">{{ o.name }}</span>
        <span v-if="!o.available" class="ks-reason">{{ o.reason || $t('workflow.kernelUnavailable') }}</span>
        <svg v-else-if="o.id === modelValue" class="ks-check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ks-trigger {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px 0 5px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
}
.ks-trigger:hover:not(:disabled) {
  background: var(--surface-soft);
}
.ks-trigger.off .ks-name {
  color: var(--text-tertiary);
}
.ks-trigger.off .ks-av {
  opacity: 0.5;
}
.ks-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ks-chev {
  width: 12px;
  height: 12px;
  flex: none;
  fill: none;
  stroke: var(--icon-muted);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ks-av {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  overflow: hidden;
  display: inline-grid;
  place-items: center;
  background: var(--surface-muted);
}
.ks-av img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ks-av.tile {
  border-radius: 5px;
  background: #fff;
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.ks-av.tile img {
  width: 70%;
  height: 70%;
  object-fit: contain;
}
.ks-menu {
  position: fixed;
  z-index: 950;
  padding: 6px;
  max-height: min(360px, calc(100vh - 16px));
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-3);
}
.ks-opt {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.ks-opt:hover:not(:disabled),
.ks-opt:focus-visible {
  background: var(--surface-hover);
  outline: none;
}
.ks-opt.on {
  font-weight: 600;
}
.ks-opt:disabled {
  cursor: not-allowed;
}
.ks-opt:disabled .ks-av {
  opacity: 0.45;
  filter: grayscale(1);
}
.ks-opt:disabled .ks-name {
  color: var(--text-tertiary);
}
.ks-reason {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
}
.ks-check {
  width: 15px;
  height: 15px;
  flex: none;
  fill: none;
  stroke: var(--text);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
