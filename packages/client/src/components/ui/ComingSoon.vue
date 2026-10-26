<script setup lang="ts">
/** 契约中“暂不实现”的模块：清晰说明状态，不放可点击的伪功能 */
defineProps<{ title: string; description: string; items?: string[] }>()
</script>

<template>
  <div class="coming-soon">
    <span class="tag">{{ $t('comingSoon.kwjy3kr') }}</span>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <ul v-if="items?.length">
      <li v-for="item in items" :key="item">{{ item }}</li>
    </ul>
    <slot />
  </div>
</template>

<style scoped>
.coming-soon {
  max-width: 560px;
  margin: 40px auto;
  padding: 28px 30px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.coming-soon h2 {
  margin: 12px 0 6px;
  font-size: 17px;
  font-weight: 600;
}
.coming-soon p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.75;
}
.coming-soon ul {
  margin: 14px 0 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.9;
}
</style>
