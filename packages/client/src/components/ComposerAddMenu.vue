<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * 输入框左侧的“+”：添加上下文菜单（关联客户 / 报价、引用邮件 / 商机 / 订单、上传文件）。
 * 键盘：Enter / 空格 / ↓ 打开并聚焦第一项，↑↓ Home End 移动，Esc 关闭并把焦点还给按钮；
 * 点菜单外、Tab 移出也会关闭。
 */
export interface AddMenuItem {
  id: string
  label: string
  icon: string
  hint?: string
}

const props = defineProps<{ items: AddMenuItem[]; disabled?: boolean; label: string }>()
const emit = defineEmits<{ select: [id: string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)

const entries = (): HTMLButtonElement[] =>
  Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

async function show(focus: 'first' | 'last' = 'first'): Promise<void> {
  if (props.disabled) return
  open.value = true
  await nextTick()
  const list = entries()
  ;(focus === 'first' ? list[0] : list[list.length - 1])?.focus()
}

function close(refocus = false): void {
  if (!open.value) return
  open.value = false
  if (refocus) trigger.value?.focus()
}

function toggle(): void {
  if (open.value) close()
  else void show()
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    void show(event.key === 'ArrowDown' ? 'first' : 'last')
  }
}

function onMenuKey(event: KeyboardEvent): void {
  const list = entries()
  const index = list.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const n = list.length
    list[(index + (event.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    list[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    list[list.length - 1]?.focus()
  } else if (event.key === 'Tab') {
    close()
  }
}

function pick(id: string): void {
  close()
  emit('select', id)
}

function onOutside(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close()
}

watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', onOutside, true)
  else document.removeEventListener('pointerdown', onOutside, true)
})
watch(
  () => props.disabled,
  (value) => value && close(),
)
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))

defineExpose({ open, close })
</script>

<template>
  <div ref="root" class="composer-add-menu">
    <button
      ref="trigger"
      type="button"
      class="composer-add"
      :class="{ on: open }"
      :title="label"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-testid="composer-add"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <AppIcon name="plus" :size="18" />
    </button>
    <div
      v-if="open"
      ref="menu"
      class="composer-add-pop"
      role="menu"
      :aria-label="label"
      data-testid="composer-add-menu"
      @keydown="onMenuKey"
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        tabindex="-1"
        class="composer-add-item"
        :data-item="item.id"
        @click="pick(item.id)"
      >
        <span class="composer-add-icon"><AppIcon :name="item.icon" :size="16" /></span>
        <span class="composer-add-text">
          <span class="composer-add-label">{{ item.label }}</span>
          <span v-if="item.hint" class="composer-add-hint">{{ item.hint }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer-add-menu {
  position: static;
  flex: 0 0 auto;
  display: flex;
}
.composer-add.on {
  background: var(--surface-hover);
  color: var(--text);
}
.composer-add-pop {
  position: absolute;
  left: 6px;
  bottom: calc(100% + 8px);
  z-index: 40;
  width: 264px;
  padding: 6px;
  border-radius: 14px;
  background: var(--surface);
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 14px 34px rgba(17, 17, 19, 0.16);
}
.composer-add-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: 0;
  border-radius: 9px;
  background: none;
  color: var(--text);
  text-align: left;
  font-size: 13.5px;
}
.composer-add-item:hover,
.composer-add-item:focus-visible,
.composer-add-item:focus {
  outline: none;
  background: var(--surface-hover);
}
.composer-add-icon {
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.composer-add-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.composer-add-label {
  font-weight: 500;
}
.composer-add-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 11.5px;
}
</style>
