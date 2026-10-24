<script setup lang="ts">
import { inject } from 'vue'
import { SIDE_SLOT_ID, SIDE_SLOT_KEY } from '../../lib/side-slot'

/** 把页面自己的二级栏放进全局侧栏中部（单侧栏：上面是这一页的内容，底部是主导航） */
const inLayout = inject(SIDE_SLOT_KEY, false)
</script>

<template>
  <Teleport defer :to="`#${SIDE_SLOT_ID}`" :disabled="!inLayout">
    <slot />
  </Teleport>
</template>
