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
  const rect = trigger.value?.getBoundingClientRect()
  const height = menu.value?.offsetHeight ?? 260
  if (rect) {
    pos.value = {
      left: Math.max(12, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 12)),
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
      <AppIcon :name="LEVEL_ICON[level]" :size="15" />
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
          <p class="kernel-title">{{ $t('permission.title') }}</p>
          <button
            v-for="value in PERMISSION_LEVELS"
            :key="value"
            type="button"
            role="menuitemradio"
            class="kernel-row perm-row"
            :class="{ checked: value === level }"
            :aria-checked="value === level"
            :disabled="!levelAllowed(value, cap)"
            :data-level="value"
            @click="pick(value)"
          >
            <span class="perm-icon" :class="`level-${value}`"><AppIcon :name="LEVEL_ICON[value]" :size="16" /></span>
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
.perm-trigger {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--surface-muted);
  color: var(--text-secondary);
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.perm-trigger:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover-overlay, var(--surface-muted));
}
.perm-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.perm-trigger.level-full {
  color: var(--info-text);
  background: var(--info-soft);
}
.perm-icon {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.perm-icon.level-full {
  color: var(--info-text);
}
.perm-row {
  align-items: flex-start;
}
.perm-row .kernel-check {
  margin-top: 6px;
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
