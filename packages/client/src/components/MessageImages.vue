<script setup lang="ts">
import { ref, watch } from 'vue'
import type { MessageAttachment } from '../api'
import { sessionImageUrl } from '../lib/session-images'
import ImageLightbox from './ImageLightbox.vue'

/** 已发送用户消息里的图片缩略图；点击放大 */
const props = defineProps<{ sessionId: string; attachments: MessageAttachment[] }>()

const urls = ref<Record<string, string>>({})
const failed = ref<Record<string, boolean>>({})
const open = ref<MessageAttachment | null>(null)

watch(
  () => [props.sessionId, props.attachments.map((a) => a.path).join('\n')] as const,
  () => {
    for (const a of props.attachments) {
      if (urls.value[a.path]) continue
      sessionImageUrl(props.sessionId, a.path)
        .then((url) => (urls.value = { ...urls.value, [a.path]: url }))
        .catch(() => (failed.value = { ...failed.value, [a.path]: true }))
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="message-images" data-testid="message-images">
    <button
      v-for="a in props.attachments"
      :key="a.path"
      type="button"
      class="message-image"
      :class="{ failed: failed[a.path] }"
      :title="a.width && a.height ? `${a.name} · ${a.width}×${a.height}` : a.name"
      :aria-label="$t('vision.open', [a.name])"
      :disabled="!urls[a.path]"
      @click="open = a"
    >
      <img v-if="urls[a.path]" :src="urls[a.path]" :alt="a.name" />
      <span v-else class="message-image-ph">{{ failed[a.path] ? $t('vision.missing') : '' }}</span>
    </button>
    <ImageLightbox v-if="open && urls[open.path]" :src="urls[open.path]" :alt="open.name" @close="open = null" />
  </div>
</template>
