<script setup lang="ts">
import { ref } from 'vue'

/**
 * 统一的文件选择：按钮 + 文件名，代替浏览器原生“Choose File / No file chosen”（不跟随界面语言、样式不统一）。
 * 真正的 <input type=file> 视觉隐藏但仍在 DOM 里（测试可 setInputFiles；data-testid 透传给它）。
 */
withDefaults(
  defineProps<{ accept?: string; fileName?: string; label?: string; testid?: string; disabled?: boolean }>(),
  { accept: undefined, fileName: '', label: '', testid: undefined, disabled: false },
)
const emit = defineEmits<{ change: [event: Event] }>()
const input = ref<HTMLInputElement | null>(null)
const picked = ref('')

function onChange(event: Event): void {
  picked.value = (event.target as HTMLInputElement).files?.[0]?.name ?? ''
  emit('change', event)
}
defineExpose({ reset: () => input.value && (input.value.value = '') })
</script>

<template>
  <span class="file-pick">
    <button type="button" class="kbtn sm" :disabled="disabled" @click="input?.click()">
      {{ label || $t('ui.chooseFile') }}
    </button>
    <span class="file-name" :class="{ empty: !(fileName || picked) }" :title="fileName || picked || undefined">{{
      fileName || picked || $t('ui.noFile')
    }}</span>
    <input
      ref="input"
      type="file"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      :accept="accept"
      :data-testid="testid"
      :disabled="disabled"
      @change="onChange"
    />
  </span>
</template>

<style scoped>
.file-pick {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
}
.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text);
}
.file-name.empty {
  color: var(--text-tertiary);
}
</style>
