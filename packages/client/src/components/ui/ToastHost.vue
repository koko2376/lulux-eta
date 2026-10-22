<script setup lang="ts">
import { ref } from 'vue'
import { copyText } from '../../lib/clipboard'
import { dismissToast, uiState } from '../../stores/ui'

const copied = ref(0)
async function copyId(id: number, requestId: string): Promise<void> {
  if (await copyText(requestId)) copied.value = id
}
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="item in uiState.toasts" :key="item.id" class="toast" :class="item.kind">
        <span class="toast-dot" aria-hidden="true"></span>
        <span class="toast-text">
          {{ item.message }}
          <span v-if="item.requestId" class="toast-rid">
            <span>{{ $t('toastHost.requestId', [item.requestId]) }}</span>
            <button type="button" class="toast-copy" @click="copyId(item.id, item.requestId)">
              {{ copied === item.id ? $t('toastHost.copied') : $t('toastHost.copy') }}
            </button>
          </span>
        </span>
        <button type="button" class="toast-close" :aria-label="$t('toastHost.k1iz1b26')" @click="dismissToast(item.id)">
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  max-width: 420px;
  min-height: 40px;
  padding: 9px 10px 9px 14px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-radius: 12px;
  /* 两种主题下都是深色浮层：文字固定浅色，不跟随 --on-strong（深色主题里它是深色） */
  background: #111113;
  color: #f4f4f6;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  line-height: 1.55;
}
.toast-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--icon-muted);
  flex: none;
  margin-top: 7px;
}
.toast.success .toast-dot {
  background: #4fd18b;
}
.toast.error .toast-dot {
  background: #ff6b6b;
}
.toast-text {
  flex: 1;
  word-break: break-word;
}
.toast-rid {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 12px;
  color: #bdbdc3;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.toast-copy {
  border: 0;
  background: rgba(255, 255, 255, 0.12);
  color: #f4f4f6;
  font-size: 11.5px;
  padding: 1px 8px;
  min-height: 22px;
  border-radius: 999px;
  font-family: var(--font-sans);
}
.toast-copy:hover,
.toast-copy:focus-visible {
  background: rgba(255, 255, 255, 0.2);
}
:global(:root[data-theme='dark']) .toast {
  background: #2c2c32;
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.5),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.toast-close {
  border: 0;
  background: none;
  color: #bdbdc3;
  font-size: 18px;
  line-height: 1;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  flex: none;
}
.toast-close:hover,
.toast-close:focus-visible {
  background: rgba(255, 255, 255, 0.12);
  color: #f4f4f6;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
