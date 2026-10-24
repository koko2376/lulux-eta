<script setup lang="ts">
import { computed } from 'vue'
import { memberTagHue } from '../lib/members'

/**
 * 群成员名字旁的小标签（群头衔）：群头衔，或同一内核多个成员时的序号（#2）。
 * 每个头衔按文字稳定取一个颜色；浅色 / 深色主题都保证对比度。
 */
const props = defineProps<{ tag: string }>()
const style = computed(() => ({ '--tag-hue': String(memberTagHue(props.tag)) }))
</script>

<template>
  <span v-if="tag" class="member-tag" :style="style" :title="tag">{{ tag }}</span>
</template>

<style scoped>
.member-tag {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 9em;
  height: 17px;
  margin-left: 5px;
  padding: 0 6px;
  overflow: hidden;
  border-radius: 5px;
  background: hsl(var(--tag-hue) 85% 94%);
  color: hsl(var(--tag-hue) 55% 34%);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 17px;
  white-space: nowrap;
  text-overflow: ellipsis;
  vertical-align: 1px;
}
:root[data-theme='dark'] .member-tag {
  background: hsl(var(--tag-hue) 35% 22%);
  color: hsl(var(--tag-hue) 80% 80%);
}
</style>
