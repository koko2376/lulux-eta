<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { request } from '../../api/http'
import { agentSidebar, toggleSidebar } from '../../lib/agent-sidebar'
import { auth } from '../../lib/session'
import { NAV_ENTRIES, navEntryFor, type NavIcon } from '../../lib/nav'
import { SIDE_SLOT_ID } from '../../lib/side-slot'
import { onTitleBarDoubleClick, windowChrome } from '../../lib/window'
import { isMac } from '../../lib/shortcuts'

/**
 * 全局侧栏（单侧栏，宽 280，收起 64）：
 * 顶部窗口拖拽区 + 收起按钮；中部是当前页面传送进来的二级栏（会话列表 / 筛选 / 设置分类）；
 * 底部 6 个主入口（LULUX / 工作台 / 客户 / 邮箱 / 工作流 / 技能）+ 账户与设置。
 */
const route = useRoute()
const section = computed(() => String(route.meta.section ?? ''))
const activeId = computed<NavIcon | null>(() => navEntryFor(section.value)?.id ?? null)
const collapsed = computed(() => agentSidebar.collapsed)
const shortcut = isMac() ? '⌘B' : 'Ctrl+B'
const username = computed(() =>
  auth.connection === 'remote' || auth.mode === 'server' ? auth.me?.user.name || auth.me?.user.email || 'koko' : auth.local.username || 'koko',
)
const initial = computed(() => username.value.trim().slice(0, 1).toUpperCase() || 'K')

/** 邮箱入口的未读角标：60 秒 / 窗口获得焦点 / 切换页面时静默刷新；没有邮箱或没有权限时不显示 */
const unread = ref(0)
let timer = 0
let unreadSeq = 0
async function loadUnread(): Promise<void> {
  // 多次触发（定时 / 回到窗口 / 切页）时只认最后一次，慢的旧请求不覆盖新数
  const seq = ++unreadSeq
  try {
    const res = await request<{ total?: number }>('/api/email/messages', {
      query: { folder: 'inbox', unread: 1, pageSize: 1 },
      silent: true,
    })
    if (seq === unreadSeq) unread.value = Number(res?.total ?? 0)
  } catch {
    if (seq === unreadSeq) unread.value = 0
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
  <aside class="app-side" :class="[{ collapsed }, `chrome-${windowChrome}`]" data-testid="app-side">
    <!-- 收起时顶部只有展开按钮（mac 让出红绿灯）；展开时页面二级栏的标题行就是顶栏 -->
    <div v-if="collapsed" class="as-top" :class="`chrome-${windowChrome}`" @dblclick="onTitleBarDoubleClick">
      <button
        type="button"
        class="as-icon-btn"
        data-testid="side-toggle"
        :title="`${$t('appRail.expand')} (${shortcut})`"
        :aria-label="$t('appRail.expand')"
        aria-expanded="false"
        @click="toggleSidebar"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
          <path d="M9.5 4.8v14.4" />
        </svg>
      </button>
    </div>

    <!-- 页面二级栏的挂载点；收起时保留挂载（只是不显示），展开后状态还在 -->
    <div :id="SIDE_SLOT_ID" class="as-slot" :inert="collapsed || undefined" :aria-hidden="collapsed || undefined"></div>

    <nav class="as-nav" :aria-label="$t('appRail.k1xoa3t3')">
      <RouterLink
        v-for="entry in NAV_ENTRIES"
        :key="entry.id"
        class="as-nav-item"
        active-class=""
        exact-active-class=""
        :class="{ on: activeId === entry.id }"
        :to="entry.to"
        :data-testid="entry.testid"
        :title="$t(entry.label)"
        :aria-current="activeId === entry.id ? 'page' : undefined"
      >
        <span class="as-nav-ico">
          <svg v-if="entry.id === 'agent'" aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 3.4l1.7 4.7 4.9 1.7-4.9 1.7L12 16.2l-1.7-4.7-4.9-1.7 4.9-1.7z" />
            <path d="M18.2 15.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
          </svg>
          <svg v-else-if="entry.id === 'workbench'" aria-hidden="true" viewBox="0 0 24 24">
            <rect x="3.5" y="3.5" width="7" height="7" rx="2.2" />
            <rect x="13.5" y="3.5" width="7" height="7" rx="2.2" />
            <rect x="3.5" y="13.5" width="7" height="7" rx="2.2" />
            <rect x="13.5" y="13.5" width="7" height="7" rx="2.2" />
          </svg>
          <svg v-else-if="entry.id === 'customers'" aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.6 19.2c.5-2.9 2.7-4.6 5.4-4.6s4.9 1.7 5.4 4.6" />
            <path d="M16.2 5.4a3 3 0 0 1 0 5.6" />
            <path d="M17.4 14.9c1.9.4 3.2 1.9 3.6 4.1" />
          </svg>
          <svg v-else-if="entry.id === 'mailbox'" aria-hidden="true" viewBox="0 0 24 24">
            <rect x="3" y="5.2" width="18" height="13.6" rx="3" />
            <path d="m3.8 7 7.3 5.3a1.5 1.5 0 0 0 1.8 0L20.2 7" />
          </svg>
          <svg v-else-if="entry.id === 'workflows'" aria-hidden="true" viewBox="0 0 24 24">
            <rect x="3.5" y="4" width="6" height="5" rx="1.8" />
            <rect x="14.5" y="4" width="6" height="5" rx="1.8" />
            <rect x="9" y="15" width="6" height="5" rx="1.8" />
            <path d="M6.5 9v1.8a1.7 1.7 0 0 0 1.7 1.7h7.6a1.7 1.7 0 0 0 1.7-1.7V9M12 12.5V15" />
          </svg>
          <svg v-else aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4.5 5.5a2 2 0 0 1 2-2H19v14H6.5a2 2 0 0 0-2 2z" />
            <path d="M4.5 19.5a2 2 0 0 0 2 1H19v-3" />
            <path d="m11.8 6.8 1.1 2.1 2.3.3-1.7 1.6.4 2.3-2.1-1.1-2.1 1.1.4-2.3-1.7-1.6 2.3-.3z" />
          </svg>
          <span
            v-if="entry.id === 'mailbox' && unread > 0"
            class="as-badge"
            :aria-label="$t('shellx.mailUnread', [unread])"
            >{{ unread > 99 ? '99+' : unread }}</span
          >
        </span>
        <span class="as-nav-label">{{ $t(entry.label) }}</span>
      </RouterLink>
    </nav>

    <div class="as-foot">
      <RouterLink
        class="as-account"
        active-class=""
        exact-active-class=""
        :class="{ on: section === 'settings' }"
        to="/settings/account"
        data-testid="rail-account"
        :title="$t('appRail.account')"
      >
        <span class="as-avatar" aria-hidden="true">{{ initial }}</span>
        <span class="as-account-name">{{ username }}</span>
      </RouterLink>
      <button
        v-if="!collapsed"
        type="button"
        class="as-icon-btn"
        data-testid="side-toggle"
        :title="`${$t('appRail.collapse')} (${shortcut})`"
        :aria-label="$t('appRail.collapse')"
        aria-expanded="true"
        @click="toggleSidebar"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
          <path d="M9.5 4.8v14.4" />
        </svg>
      </button>
      <RouterLink
        class="as-icon-btn as-settings"
        active-class=""
        exact-active-class=""
        :class="{ on: section === 'settings' }"
        to="/settings/models"
        data-testid="rail-settings"
        :title="$t('appRail.kyxspmz')"
        :aria-label="$t('appRail.kyxspmz')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="2.9" />
          <path
            d="M19.3 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z"
          />
        </svg>
      </RouterLink>
    </div>
  </aside>
</template>
