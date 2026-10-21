<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { request } from '../api/http'
import logoUrl from '../assets/lulux-neutral.png'
import { windowChrome } from '../lib/window'

const route = useRoute()
const section = computed(() => String(route.meta.section ?? ''))

/** 邮箱图标上的黑色未读角标（原版）：收件箱未读数，60 秒 / 窗口获得焦点 / 切换页面时静默刷新；没有邮箱或没有权限时不显示 */
const unread = ref(0)
let timer = 0
async function loadUnread(): Promise<void> {
  try {
    const res = await request<{ total?: number }>('/api/email/messages', {
      query: { folder: 'inbox', unread: 1, pageSize: 1 },
      silent: true,
    })
    unread.value = Number(res?.total ?? 0)
  } catch {
    unread.value = 0
  }
}
function onFocus(): void {
  void loadUnread()
}
onMounted(() => {
  void loadUnread()
  timer = window.setInterval(() => void loadUnread(), 60_000)
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  window.removeEventListener('focus', onFocus)
})
watch(section, () => void loadUnread())
</script>

<template>
  <nav class="rail" :aria-label="$t('appRail.k1xoa3t3')">
    <!-- mac：原生红绿灯在这里（hiddenInset），只留拖拽空位；Windows / Linux 按钮在右上角；浏览器只留一点间距 -->
    <div class="rail-top" :class="`chrome-${windowChrome}`" aria-hidden="true"></div>

    <!-- LULUX（Agent 会话）排第一；进入应用的首页仍是工作台（/） -->
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'agent' }"
      to="/agent"
      data-testid="rail-agent"
      :title="$t('appRail.agent')"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3.4l1.7 4.7 4.9 1.7-4.9 1.7L12 16.2l-1.7-4.7-4.9-1.7 4.9-1.7z" />
        <path d="M18.2 15.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
      </svg>
      <span>{{ $t('appRail.agent') }}</span>
    </RouterLink>
    <RouterLink class="rail-item" active-class="" exact-active-class="" :class="{ on: section === 'workbench' }" to="/">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
      </svg>
      <span>{{ $t('appRail.k10rnjfv') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'customers' }"
      to="/customers"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.6 19.2c.5-2.9 2.7-4.6 5.4-4.6s4.9 1.7 5.4 4.6" />
        <path d="M16.2 5.4a3 3 0 0 1 0 5.6" />
        <path d="M17.4 14.9c1.9.4 3.2 1.9 3.6 4.1" />
      </svg>
      <span>{{ $t('appRail.k1v5iwp2') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'quotation' }"
      to="/quotation"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M14 3.5H7.2A2.2 2.2 0 0 0 5 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5z" />
        <path d="M14 3.5v5h5" />
        <path d="M8.6 12.6h6.8M8.6 16.2h4.4" />
      </svg>
      <span>{{ $t('appRail.kxbx0dt') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'deals' }"
      to="/deals"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 5.5h16l-6 7.2v5.6l-4 1.7v-7.3z" />
      </svg>
      <span>{{ $t('appRail.deals') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'orders' }"
      to="/orders"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" />
        <path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9" />
      </svg>
      <span>{{ $t('appRail.orders') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'mailbox' }"
      to="/mailbox"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="5.2" width="18" height="13.6" rx="2.4" />
        <path d="m3.8 7 7.3 5.3a1.5 1.5 0 0 0 1.8 0L20.2 7" />
      </svg>
      <span v-if="unread > 0" class="badge" :aria-label="$t('shellx.mailUnread', [unread])">{{
        unread > 99 ? '99+' : unread
      }}</span>
      <span>{{ $t('appRail.k182knuk') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'workflows' }"
      to="/workflows"
      data-testid="rail-workflows"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3.5" y="4" width="6" height="5" rx="1.6" />
        <rect x="14.5" y="4" width="6" height="5" rx="1.6" />
        <rect x="9" y="15" width="6" height="5" rx="1.6" />
        <path d="M6.5 9v1.8a1.7 1.7 0 0 0 1.7 1.7h7.6a1.7 1.7 0 0 0 1.7-1.7V9M12 12.5V15" />
      </svg>
      <span>{{ $t('workflow.rail') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'schedules' }"
      to="/schedules"
      data-testid="rail-schedules"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12.5" r="7.6" />
        <path d="M12 8.4v4.3l2.8 1.7M9.5 3.5h5" />
      </svg>
      <span>{{ $t('schedule.rail') }}</span>
    </RouterLink>
    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'skills' }"
      to="/skills"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4.5 5.5a2 2 0 0 1 2-2H19v14H6.5a2 2 0 0 0-2 2z" />
        <path d="M4.5 19.5a2 2 0 0 0 2 1H19v-3" />
        <path d="m11.8 6.8 1.1 2.1 2.3.3-1.7 1.6.4 2.3-2.1-1.1-2.1 1.1.4-2.3-1.7-1.6 2.3-.3z" />
      </svg>
      <span>{{ $t('appRail.kn9kmfv') }}</span>
    </RouterLink>

    <div class="rail-spacer"></div>

    <RouterLink
      class="rail-item"
      active-class=""
      exact-active-class=""
      :class="{ on: section === 'settings' }"
      to="/settings/models"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="2.9" />
        <path
          d="M19.3 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z"
        />
      </svg>
      <span>{{ $t('appRail.kyxspmz') }}</span>
    </RouterLink>
    <RouterLink class="rail-logo" to="/settings/about" :aria-label="$t('appRail.kke9idm')">
      <img :src="logoUrl" alt="" />
      <span>LULUX</span>
    </RouterLink>
  </nav>
</template>
