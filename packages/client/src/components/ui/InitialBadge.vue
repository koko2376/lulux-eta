<script setup lang="ts">
import { computed } from 'vue'

/** 中性首字母徽标：内核卡片、客户头像都用它，不使用任何第三方 logo */
const props = withDefaults(defineProps<{ name: string; size?: number; square?: boolean }>(), {
  size: 34,
  square: false,
})
const initials = computed(() => {
  const words = props.name
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean)
  if (!words.length) return '?'
  if (/^[\u4e00-\u9fa5]/.test(words[0])) return words[0].slice(0, 1)
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
})
</script>

<template>
  <span
    class="ini"
    :class="{ square }"
    aria-hidden="true"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.34)}px` }"
    >{{ initials }}</span
  >
</template>

<style scoped>
.ini.square {
  border-radius: 10px;
  background: var(--surface-muted);
  box-shadow: none;
}
</style>
