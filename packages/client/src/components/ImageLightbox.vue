<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'

/** 点击缩略图放大查看：点遮罩、关闭按钮或按 Esc 关闭 */
const props = defineProps<{ src: string; alt?: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="props.alt || $t('vision.preview')"
      data-testid="image-lightbox"
      @click.self="emit('close')"
    >
      <img :src="props.src" :alt="props.alt || ''" />
      <button type="button" class="image-lightbox-close" :aria-label="$t('vision.closePreview')" @click="emit('close')">
        <AppIcon name="close" :size="16" />
      </button>
    </div>
  </Teleport>
</template>
