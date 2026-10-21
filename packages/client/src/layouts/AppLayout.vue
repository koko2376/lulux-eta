<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppRail from '../components/AppRail.vue'
import CommandPalette from '../components/CommandPalette.vue'
import ShortcutsHelp from '../components/ShortcutsHelp.vue'
import { focusComposer, matchShortcut, shortcutUi, type ShortcutAction } from '../lib/shortcuts'
import { clearSession } from '../lib/session'
import { useAppStore } from '../stores/app'
import { startScheduleNotices } from '../stores/automation-events'
import { onServerEvent, startEvents, stopEvents } from '../stores/events'
import { startGroupLive } from '../stores/group-live'
import { toast } from '../stores/ui'
import { t } from '../i18n'

const router = useRouter()
const store = useAppStore()
let off: (() => void) | null = null
let offTitle: (() => void) | null = null
let offRun: (() => void) | null = null
let offSchedules: (() => void) | null = null
let offGroups: (() => void) | null = null

/** 全局快捷键（见 lib/shortcuts.ts）；对话框打开时只响应面板 / 帮助的开关 */
async function runShortcut(action: ShortcutAction): Promise<void> {
  if (action === 'palette') {
    shortcutUi.help = false
    shortcutUi.palette = !shortcutUi.palette
    return
  }
  if (action === 'help') {
    shortcutUi.palette = false
    shortcutUi.help = !shortcutUi.help
    return
  }
  shortcutUi.palette = false
  shortcutUi.help = false
  if (action === 'newChat') {
    if (router.currentRoute.value.name !== 'agent') await router.push({ name: 'agent' })
    await store.newSession().catch(() => undefined)
    await nextTick()
    focusComposer()
    return
  }
  if (action === 'focusComposer') {
    if (focusComposer()) return
    if (router.currentRoute.value.name !== 'agent') {
      await router.push({ name: 'agent' })
      await nextTick()
      focusComposer()
    }
  }
}

function modalOpen(): boolean {
  return Boolean(document.querySelector('.modal-backdrop'))
}

function onKeydown(event: KeyboardEvent): void {
  const action = matchShortcut(event)
  if (!action) return
  // 其他对话框（确认框等）打开时不抢键；面板 / 帮助自己的开关除外
  const ours = shortcutUi.palette || shortcutUi.help
  if (modalOpen() && !ours) return
  if (ours && action !== 'palette' && action !== 'help') return
  event.preventDefault()
  void runShortcut(action)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  startEvents()
  // server 模式：会话被登出 / 重置密码 / 停用 → 回登录页
  off = onServerEvent('session.revoked', async () => {
    await clearSession()
    toast.info(t('appLayout.k1p35bg5'))
    await router.replace({ name: 'login' })
  })
  // 自动标题生成完成（契约 §6.3 /api/events session.title）→ 更新侧栏
  offTitle = onServerEvent('session.title', (data) => {
    const { sessionId, title } = data as { sessionId: string; title: string }
    store.applySessionTitle(sessionId, title)
  })
  // 会话运行开始 / 结束（契约 §6.9 /api/events session.run）→ 侧栏运行中标记；正在看的会话接上运行流
  offRun = onServerEvent('session.run', (data) => {
    const { sessionId, running, runId } = data as { sessionId: string; running: boolean; runId?: string }
    void store.applyRunState(sessionId, running, runId)
  })
  // 定时任务跑完（契约 schedule.run）→ 任意页面弹提示
  offSchedules = startScheduleNotices()
  // 多人群聊：新消息 / 成员变化实时同步（契约 §6.10.4）
  offGroups = startGroupLive()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  shortcutUi.palette = false
  shortcutUi.help = false
  off?.()
  offTitle?.()
  offRun?.()
  offSchedules?.()
  offGroups?.()
  stopEvents()
})
</script>

<template>
  <div class="shell">
    <AppRail />
    <RouterView />
  </div>
  <CommandPalette v-if="shortcutUi.palette" @close="shortcutUi.palette = false" />
  <ShortcutsHelp v-if="shortcutUi.help" @close="shortcutUi.help = false" />
</template>
