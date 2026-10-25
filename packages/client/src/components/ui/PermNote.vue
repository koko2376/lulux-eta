<script setup lang="ts">
import { computed } from 'vue'
import type { Permission } from '../../api'
import { can, denyReason } from '../../lib/session'

/** 页面顶部的只读提示：当前角色缺少该页面的写权限时显示 */
const props = withDefaults(defineProps<{ perm: Permission; text?: string }>(), { text: '' })
const show = computed(() => !can(props.perm))
</script>

<template>
  <div v-if="show" class="perm-note" role="note" data-testid="perm-note">
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
    <span>{{ text || $t('permNote.k1so5szz', [denyReason(perm)]) }}</span>
  </div>
</template>
