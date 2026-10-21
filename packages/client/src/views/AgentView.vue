<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatView from '../components/ChatView.vue'
import Sidebar from '../components/Sidebar.vue'
import { agentSidebar, isSidebarShortcut, toggleSidebar } from '../lib/agent-sidebar'
import { sessionSelectPending, useAppStore } from '../stores/app'
import '../styles/agent.css'

const store = useAppStore()
const route = useRoute()
const router = useRouter()

/** ?prompt=…&quote=…&customer=…（报价“让 LULUX 核价”等入口）：新会话 + 绑定上下文 + 预填输入框，用户确认后再发 */
async function openPrefill(): Promise<boolean> {
  const prompt = typeof route.query.prompt === 'string' ? route.query.prompt : ''
  if (!prompt) return false
  const quoteId = typeof route.query.quote === 'string' ? route.query.quote : null
  const customerId = typeof route.query.customer === 'string' ? route.query.customer : null
  await router.replace({ query: {} })
  await store.newSession().catch(() => undefined)
  if (quoteId || customerId) await store.setContext({ customerId, quoteId }).catch(() => undefined)
  store.failedDraft = prompt
  return true
}

async function openFromQuery(): Promise<boolean> {
  const id = typeof route.query.session === 'string' ? route.query.session : ''
  if (!id || !store.sessions.some((s) => s.id === id)) return false
  await store.selectSession(id).catch(() => undefined)
  return true
}

watch(
  () => route.query.session,
  () => void openFromQuery(),
)
watch(
  () => route.query.prompt,
  (p) => {
    if (p && store.ready) void openPrefill()
  },
)

/** Ctrl/⌘+B：收起 / 展开左侧会话列表 */
function onKeydown(event: KeyboardEvent): void {
  if (!isSidebarShortcut(event)) return
  event.preventDefault()
  toggleSidebar()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

onMounted(async () => {
  if (!store.ready) await store.bootstrap()
  if (await openPrefill()) return
  if (await openFromQuery()) return

  // 进入页面时接着上次的会话；一个都没有就新建一个，方便直接开口
  if (!store.currentSessionId && !sessionSelectPending()) {
    const first = store.sessions[0]
    if (first) await store.selectSession(first.id).catch(() => undefined)
    else await store.newSession().catch(() => undefined)
  }
})
</script>

<template>
  <div class="agent-page" :class="{ 'sidebar-collapsed': agentSidebar.collapsed }">
    <Sidebar :inert="agentSidebar.collapsed || undefined" :aria-hidden="agentSidebar.collapsed || undefined" />
    <ChatView />
  </div>
</template>
