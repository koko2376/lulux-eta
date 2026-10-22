<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/** dismissible=false：没有 ×，Esc / 点遮罩不关闭（必须点对话框里的按钮，例如“我已保存”） */
const props = withDefaults(defineProps<{ title: string; width?: number; subtitle?: string; dismissible?: boolean }>(), {
  width: 520,
  subtitle: '',
  dismissible: true,
})
const emit = defineEmits<{ close: [] }>()
const box = ref<HTMLElement | null>(null)
let previous: Element | null = null

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (props.dismissible) emit('close')
  }
  // 简单的焦点陷阱：Tab 不跑出对话框
  if (event.key === 'Tab' && box.value) {
    const focusables = box.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

onMounted(async () => {
  previous = document.activeElement
  document.addEventListener('keydown', onKey, true)
  await nextTick()
  const target = box.value?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary')
  ;(target ?? box.value)?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  if (previous instanceof HTMLElement) previous.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="props.dismissible && emit('close')">
      <div
        ref="box"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        :style="{ width: `min(${width}px, calc(100vw - 32px))` }"
      >
        <header class="modal-head">
          <div>
            <h2>{{ title }}</h2>
            <p v-if="subtitle">{{ subtitle }}</p>
          </div>
          <button
            v-if="dismissible"
            type="button"
            class="modal-x"
            :aria-label="$t('uiModal.ktzla4f')"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-foot"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: var(--backdrop);
  display: grid;
  place-items: center;
  padding: 16px;
}
.modal {
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
  outline: none;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 20px 12px;
}
.modal-head > div {
  flex: 1;
  min-width: 0;
}
.modal-head h2 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
}
.modal-head p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.modal-x {
  border: 0;
  background: none;
  font-size: 20px;
  line-height: 1;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text-secondary);
}
.modal-x:hover,
.modal-x:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
}
.modal-body {
  padding: 4px 20px 16px;
  overflow: auto;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--line);
}
</style>
