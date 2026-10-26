<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { tabActive, tabsFor } from '../../lib/nav'

/** 页面分组标签（客户：线索 / 客户 / 商机 / 报价 / 订单；邮箱：收件箱 / 开发信序列；工作流：工作流 / 定时任务） */
const route = useRoute()
const tabs = computed(() => tabsFor(String(route?.meta?.section ?? '')))
</script>

<template>
  <nav v-if="tabs.length" class="section-tabs" :aria-label="$t('appRail.sectionTabs')" data-testid="section-tabs">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.to"
      class="section-tab"
      active-class=""
      exact-active-class=""
      :class="{ on: tabActive(tab, route.path) }"
      :to="tab.to"
      :data-testid="tab.testid"
      :aria-current="tabActive(tab, route.path) ? 'page' : undefined"
      >{{ $t(tab.label) }}</RouterLink
    >
  </nav>
</template>
