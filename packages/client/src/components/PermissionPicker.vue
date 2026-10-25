<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import {
  LEVEL_ICON,
  PERMISSION_LEVELS,
  levelAllowed,
  readonlyAskKernels,
  type PermissionLevel,
} from '../lib/permissions'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import { toCssRect, viewportCss } from '../lib/ui-zoom'
import AppIcon from './AppIcon.vue'

/**
 * 输入框旁的权限选择器（契约 §6.11）：仅可查看 / 需审批 / 完全权限，按会话保存。
 * 超过管理员上限的级别置灰；群聊里级别作用于全部成员。
 */
const store = useAppStore()
const MENU_WIDTH = 312

const open = ref(false)
const busy = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })

const level = computed(() => store.currentPermissionLevel)
const cap = computed(() => store.permissionCap)
/** 只能退回仅可查看的 CLI 内核（需审批时给提示） */
const fallbackKernels = computed(() => readonlyAskKernels(store.currentAgents, store.permissionInfo?.kernels))
const readOnlySession = computed(() => Boolean(store.currentSession?.workflowRunId))
/** 群聊里只有群主 / 群管理员能改（服务端同样校验） */
const canManage = computed(() => {
  const role = store.currentSession?.myRole
  return !role || role === 'owner' || role === 'admin'
})

function label(value: PermissionLevel): string {
  return t(`permission.${value}`)
}

async function toggle(): Promise<void> {
  if (open.value) {
    close()
    return
  }
  open.value = true
  await nextTick()
  const raw = trigger.value?.getBoundingClientRect()
  const height = menu.value?.offsetHeight ?? 260
  if (raw) {
    // 界面缩放时 rect / innerWidth 是视觉像素，弹层坐标要 CSS 像素
    const rect = toCssRect(raw)
    const viewport = viewportCss()
    pos.value = {
      left: Math.max(12, Math.min(rect.left, viewport.width - MENU_WIDTH - 12)),
      top: Math.max(12, rect.top - height - 8),
    }
  }
  window.addEventListener('keydown', onKey)
  menu.value?.querySelector<HTMLButtonElement>('.perm-row.checked, .perm-row:not(:disabled)')?.focus()
}

function close(): void {
  open.value = false
  window.removeEventListener('keydown', onKey)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
    trigger.value?.focus()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const items = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('.perm-row:not(:disabled)') ?? [])
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next].focus()
  }
}

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

async function pick(value: PermissionLevel): Promise<void> {
  if (!levelAllowed(value, cap.value) || busy.value) return
  close()
  if (value === level.value && store.currentSession?.permissionLevel === value) return
  busy.value = true
  try {
    await store.setPermissionLevel(value)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="perm-picker">
    <button
      ref="trigger"
      type="button"
      class="perm-trigger"
      :class="`level-${level}`"
      data-testid="permission-picker"
      :data-level="level"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      :aria-label="$t('permission.triggerAria', [label(level)])"
      :title="$t('permission.triggerAria', [label(level)])"
      :disabled="busy || readOnlySession || !canManage"
      @click="toggle"
    >
      <span class="perm-trigger-icon"><AppIcon :name="LEVEL_ICON[level]" :size="14" /></span>
      <span class="perm-trigger-label">{{ label(level) }}</span>
      <AppIcon name="chevron-down" :size="12" class="perm-trigger-chevron" />
    </button>
    <Teleport to="body">
      <div v-if="open" class="kernel-backdrop" @mousedown.self="close">
        <div
          ref="menu"
          class="kernel-menu perm-menu"
          role="menu"
          :aria-label="$t('permission.title')"
          data-testid="permission-menu"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${MENU_WIDTH}px` }"
        >
          <p class="kernel-title perm-title">{{ $t('permission.title') }}</p>
          <button
            v-for="value in PERMISSION_LEVELS"
            :key="value"
            type="button"
            role="menuitemradio"
            class="kernel-row perm-row"
            :class="[`level-${value}`, { checked: value === level }]"
            :aria-checked="value === level"
            :disabled="!levelAllowed(value, cap)"
            :data-level="value"
            @click="pick(value)"
          >
            <span class="perm-icon"><AppIcon :name="LEVEL_ICON[value]" :size="16" /></span>
            <span class="kernel-text perm-text">
              <strong>{{ label(value) }}</strong>
              <span>{{ $t(`permission.${value}Desc`) }}</span>
              <span v-if="!levelAllowed(value, cap)" class="perm-capped">{{ $t('permission.capped') }}</span>
            </span>
            <AppIcon v-if="value === level" name="check" :size="16" class="kernel-check" />
          </button>
          <p v-if="level === 'ask' && fallbackKernels.length" class="perm-hint" data-testid="permission-fallback-hint">
            <AppIcon name="info" :size="13" />
            <span>{{ $t('permission.askFallback', [fallbackKernels.join(' / ')]) }}</span>
          </p>
          <p v-if="store.isGroupChat" class="perm-foot">{{ $t('permission.groupNote') }}</p>
          <p class="perm-foot">
            {{ $t('permission.defaultNote', [label(store.defaultPermissionLevel)])
            }}<RouterLink to="/settings/mcp" @click="close">{{ $t('permission.defaultLink') }}</RouterLink>
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.perm-picker {
  flex: 0 0 auto;
  display: flex;
}
/* 触发钮：无边框的灰色文字按钮，和右边的模型选择器同一种样式、放在一起；
   只有图标带档位色（仅可查看=绿、需审批=蓝），完全权限是唯一要提醒的状态，整颗染红 */
.perm-trigger {
  --perm-fg: var(--text-tertiary);
  --perm-bg: transparent;
  height: 38px;
  max-width: 140px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13.5px;
  white-space: nowrap;
  transition:
    color 0.12s ease,
    background 0.12s ease;
}
.perm-trigger-icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--perm-fg);
}
.perm-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.perm-trigger-chevron {
  flex: 0 0 auto;
  margin-left: -1px;
  transition: transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}
.perm-trigger[aria-expanded='true'] .perm-trigger-chevron {
  transform: rotate(180deg);
}
.perm-trigger:hover:not(:disabled),
.perm-trigger[aria-expanded='true'] {
  color: var(--text-secondary);
}
.perm-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.perm-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.perm-trigger.level-read,
.perm-icon.level-read {
  --perm-fg: var(--good);
  --perm-bg: var(--good-soft);
}
.perm-trigger.level-ask,
.perm-icon.level-ask {
  --perm-fg: var(--info-text);
  --perm-bg: var(--info-soft);
}
.perm-trigger.level-full,
.perm-icon.level-full {
  --perm-fg: var(--danger-text);
  --perm-bg: var(--danger-soft);
}
.perm-trigger.level-full,
.perm-trigger.level-full:hover:not(:disabled),
.perm-trigger.level-full[aria-expanded='true'] {
  color: var(--danger-text);
}
/* 窄窗口只留图标 */
@media (max-width: 760px) {
  .perm-trigger-label,
  .perm-trigger-chevron {
    display: none;
  }
}
/* 菜单：标题是一句问题；每行线框图标 + 名称 + 说明，不加圆底。
   选中行浅灰底，图标和对勾带档位色（仅可查看=绿、需审批=蓝、完全权限=红） */
.perm-title {
  padding-right: 8px;
}
.perm-icon {
  width: 20px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  margin-top: 1px;
  color: var(--text-secondary);
}
.perm-row {
  align-items: flex-start;
  gap: 10px;
}
.perm-row.level-read {
  --perm-fg: var(--good);
}
.perm-row.level-ask {
  --perm-fg: var(--info-text);
}
.perm-row.level-full {
  --perm-fg: var(--danger-text);
}
/* 选中行：中性浅灰底，文字不变色；只有图标和对勾带档位色 */
.perm-row.checked,
.perm-row.checked:hover {
  background: var(--hover-overlay-strong, var(--hover-overlay));
}
.perm-row.checked .perm-icon,
.perm-row.checked .kernel-check {
  color: var(--perm-fg);
}
.perm-row .kernel-check {
  margin-top: 2px;
}
.perm-row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.perm-text span {
  white-space: normal;
  line-height: 1.4;
}
.perm-capped {
  color: var(--text-tertiary) !important;
}
.perm-hint {
  display: flex;
  gap: 6px;
  margin: 6px 8px 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.45;
}
.perm-hint svg {
  flex: 0 0 auto;
  margin-top: 2px;
}
.perm-foot {
  margin: 6px 8px 2px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
}
.perm-foot a {
  margin-left: 4px;
  color: var(--text-secondary);
  text-decoration: underline;
}
</style>
