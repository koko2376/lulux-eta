<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NotificationBell from '../NotificationBell.vue'
import GlobalSearch from './GlobalSearch.vue'
import SettingsSearch from './SettingsSearch.vue'
import { askLulux } from '../../lib/ask-lulux'

/**
 * 页面顶栏：标题 + 灰色副标题，右侧依次是页面按钮（slot）、灰色全局搜索框、通知铃（小图标）、
 * 黑色「✦ 问 LULUX」胶囊按钮。客户页传 askCustomer，问 LULUX 时把会话绑定到这个客户。
 * 设置页顶栏只有灰色「搜索设置…」（没有全局搜索 / 问 LULUX）：/settings/* 默认换成 SettingsSearch、不显示问 LULUX；
 * 技能页（/skills*，有自己的筛选框）默认两者都不显示。search / ask 显式传值时以传值为准。
 */
const props = withDefaults(
  defineProps<{
    title: string
    sub?: string
    bell?: boolean
    search?: boolean
    ask?: boolean
    askCustomer?: string
    /** 面包屑（如客户详情：客户 › 公司名）：给出上级，标题作为最后一级 */
    crumbs?: Array<{ label: string; to: string }>
  }>(),
  { sub: undefined, bell: true, search: undefined, ask: undefined, askCustomer: undefined, crumbs: undefined },
)
const router = useRouter()
const route = useRoute()
const isSettings = computed(() => route.path.startsWith('/settings'))
const isConfig = computed(() => isSettings.value || route.path.startsWith('/skills'))
const showSearch = computed(() => props.search ?? !isConfig.value)
const showSettingsSearch = computed(() => props.search === undefined && isSettings.value)
const showAsk = computed(() => props.ask ?? !isConfig.value)
function onAsk(): void {
  void askLulux(router, props.askCustomer ? { customerId: props.askCustomer } : {})
}
</script>

<template>
  <div class="topbar">
    <nav v-if="crumbs?.length" class="crumb" :aria-label="$t('shellx.crumb')">
      <template v-for="c in crumbs" :key="c.to">
        <RouterLink :to="c.to">{{ c.label }}</RouterLink>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
      </template>
    </nav>
    <h1 class="tb-title" :class="{ 'crumb-cur': crumbs?.length }" :title="title">{{ title }}</h1>
    <div v-if="sub" class="tb-sub">{{ sub }}</div>
    <slot name="title-after" />
    <div class="tb-spacer"></div>
    <slot />
    <GlobalSearch v-if="showSearch" class="tb-search" />
    <SettingsSearch v-else-if="showSettingsSearch" class="tb-search" />
    <NotificationBell v-if="bell" />
    <button v-if="showAsk" type="button" class="btn agent" data-testid="ask-lulux" @click="onAsk">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3.2l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" /></svg>
      {{ $t('shellx.askLulux') }}
    </button>
  </div>
</template>

<style scoped>
.crumb {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  flex: none;
}
.crumb a {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  color: inherit;
}
.crumb a:hover {
  color: var(--text);
}
.crumb svg {
  width: 13px;
  height: 13px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
}
.crumb-cur {
  font-size: 12.5px;
}
</style>
