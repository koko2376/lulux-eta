<script setup lang="ts">
import { computed } from 'vue'
import { avatarHue, initialsOf } from '../../lib/group-members'

/** 同事头像：账号没有头像图片，用名字的字 + 由账号 id 算出的稳定底色 */
const props = withDefaults(defineProps<{ userId: string; name: string; size?: number }>(), { size: 28 })
const hue = computed(() => avatarHue(props.userId))
const text = computed(() => initialsOf(props.name))
</script>

<template>
  <span
    class="human-avatar"
    :style="{
      '--avatar-size': `${size}px`,
      '--avatar-hue': String(hue),
    }"
    :title="name"
    role="img"
    :aria-label="name"
    >{{ text }}</span
  >
</template>

<style scoped>
.human-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: var(--avatar-size);
  height: var(--avatar-size);
  border-radius: 50%;
  background: hsl(var(--avatar-hue) 46% 88%);
  color: hsl(var(--avatar-hue) 42% 30%);
  font-size: calc(var(--avatar-size) * 0.42);
  font-weight: 650;
  line-height: 1;
  letter-spacing: 0;
  -webkit-user-select: none;
  user-select: none;
}
:global(:root[data-theme='dark']) .human-avatar {
  background: hsl(var(--avatar-hue) 26% 26%);
  color: hsl(var(--avatar-hue) 50% 82%);
}
</style>
