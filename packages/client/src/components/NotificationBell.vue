<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import * as api from '../api'
import { formatDate } from '../lib/labels'
import { formatMoney } from '../lib/quote'
import { sessionDisplayName } from '../lib/session-name'
import { can } from '../lib/session'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/ui'
import { t } from '../i18n'

/**
 * 顶栏通知铃：今天到期（含已过期）的任务 + 等待审批的工具调用 + 逾期应收。
 * 任务 / 应收每 60 秒和窗口获得焦点时刷新（静默请求，没有权限或离线时那一组为空）；审批来自本窗口已知的会话运行。
 */
const store = useAppStore()
const router = useRouter()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const tasks = ref<api.Task[]>([])
const overdue = ref<api.Order[]>([])
const loaded = ref(false)
let timer = 0

const approvals = computed(() => {
  const out: { sessionId: string; requestId: string; tool: string; session: string }[] = []
  for (const run of Object.values(store.runs)) {
    for (const tool of run.tools) {
      if (tool.status !== 'pending') continue
      const session = store.sessions.find((s) => s.id === run.sessionId)
      out.push({
        sessionId: run.sessionId,
        requestId: tool.requestId,
        tool: tool.server ? `${tool.server} · ${tool.name}` : tool.name,
        session: session ? sessionDisplayName(session) : t('notify.untitledSession'),
      })
    }
  }
  return out
})
const count = computed(() => tasks.value.length + approvals.value.length + overdue.value.length)
const badge = computed(() => (count.value > 99 ? '99+' : String(count.value)))

async function refresh(): Promise<void> {
  const [tk, rc] = await Promise.allSettled([
    api.tasksApi.list({ status: 'open', due: 'today', limit: 20 }, true),
    api.ordersApi.receivables({ overdue: 1, limit: 20 }, true),
  ])
  tasks.value = tk.status === 'fulfilled' ? tk.value.items : []
  overdue.value = rc.status === 'fulfilled' ? rc.value.items.filter((o) => o.overdue) : []
  loaded.value = true
}

function toggle(): void {
  open.value = !open.value
  if (open.value) void refresh()
}
function close(): void {
  open.value = false
}
function onDocPointer(e: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}
function onFocus(): void {
  void refresh()
}

async function goTask(task: api.Task): Promise<void> {
  close()
  if (task.customerId) await router.push(`/customers/${task.customerId}`)
}
async function doneTask(task: api.Task): Promise<void> {
  try {
    await api.tasksApi.update(task.id, { status: 'done' })
    tasks.value = tasks.value.filter((x) => x.id !== task.id)
    toast.success(t('notify.taskDone'))
  } catch {
    // 错误由全局 toast 展示
  }
}
async function goApproval(sessionId: string): Promise<void> {
  close()
  await router.push('/agent')
  await store.selectSession(sessionId)
}
async function goOrder(order: api.Order): Promise<void> {
  close()
  await router.push(`/orders/${order.id}`)
}

onMounted(() => {
  void refresh()
  timer = window.setInterval(() => void refresh(), 60_000)
  document.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onFocus)
})
</script>

<template>
  <div ref="root" class="bell-wrap">
    <button
      type="button"
      class="icon-button bell"
      :class="{ active: open }"
      :aria-label="count ? $t('notify.titleCount', [count]) : $t('notify.title')"
      :title="$t('notify.title')"
      :aria-expanded="open"
      aria-haspopup="true"
      data-testid="notify-bell"
      @click="toggle"
    >
      <AppIcon name="bell" :size="18" />
      <span v-if="count" class="bell-badge" aria-hidden="true">{{ badge }}</span>
    </button>
    <section v-if="open" class="bell-pop" role="region" :aria-label="$t('notify.title')" data-testid="notify-panel">
      <header class="bell-head">{{ $t('notify.title') }}</header>
      <div v-if="loaded && !count" class="bell-empty">{{ $t('notify.empty') }}</div>
      <div v-if="tasks.length" class="bell-group">
        <div class="bell-gtitle">{{ $t('notify.tasks') }} · {{ tasks.length }}</div>
        <div v-for="task in tasks" :key="task.id" class="bell-item">
          <button type="button" class="bell-main" @click="goTask(task)">
            <span class="bell-t">{{ task.title }}</span>
            <span class="bell-s" :class="{ bad: task.overdue }"
              >{{ task.overdue ? $t('notify.overdue') : $t('notify.dueToday') }} · {{ formatDate(task.dueAt)
              }}<template v-if="task.customerName"> · {{ task.customerName }}</template></span
            >
          </button>
          <button
            v-if="can('data:write')"
            type="button"
            class="kbtn sm bell-done"
            :aria-label="$t('notify.markDoneOf', [task.title])"
            @click="doneTask(task)"
          >
            {{ $t('notify.markDone') }}
          </button>
        </div>
      </div>
      <div v-if="approvals.length" class="bell-group">
        <div class="bell-gtitle">{{ $t('notify.approvals') }} · {{ approvals.length }}</div>
        <div v-for="a in approvals" :key="a.requestId" class="bell-item">
          <button type="button" class="bell-main" @click="goApproval(a.sessionId)">
            <span class="bell-t">{{ a.tool }}</span>
            <span class="bell-s">{{ a.session }}</span>
          </button>
        </div>
      </div>
      <div v-if="overdue.length" class="bell-group">
        <div class="bell-gtitle">{{ $t('notify.receivables') }} · {{ overdue.length }}</div>
        <div v-for="o in overdue" :key="o.id" class="bell-item">
          <button type="button" class="bell-main" @click="goOrder(o)">
            <span class="bell-t"
              >{{ o.number }} · <b>{{ formatMoney(o.balance, o.currency) }}</b></span
            >
            <span class="bell-s bad">{{ $t('crm.overdueDays', [o.overdueDays]) }} · {{ o.customerName }}</span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.bell-wrap {
  position: relative;
  display: inline-flex;
}
/* 自带按钮样式：.icon-button 定义在 agent.css（只随 Agent 页懒加载），
   在其他页面首屏会退回成原生灰底按钮、角标压住图标 */
.bell {
  position: relative;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background 0.14s ease,
    color 0.14s ease;
}
.bell:hover,
.bell.active {
  background: var(--surface-hover);
  color: var(--text);
}
.bell:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.bell-badge {
  position: absolute;
  /* 角标贴右上角，只压住铃铛的一角（原 top:2/right:1 盖住了大半个图标） */
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--surface);
}
.bell-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 80;
  width: 360px;
  max-height: min(70vh, 520px);
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  padding: 6px 0 8px;
}
.bell-head {
  padding: 10px 16px 6px;
  font-weight: 600;
  font-size: 13.5px;
}
.bell-empty {
  padding: 18px 16px 14px;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.bell-group + .bell-group {
  border-top: 1px solid var(--line);
  margin-top: 4px;
  padding-top: 4px;
}
.bell-gtitle {
  padding: 8px 16px 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
  font-weight: 500;
}
.bell-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 6px;
}
.bell-main {
  all: unset;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border-radius: 10px;
  cursor: pointer;
}
.bell-main:hover {
  background: var(--surface-hover);
}
.bell-main:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.bell-t {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bell-s {
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bell-s.bad {
  color: var(--danger-text);
}
.bell-done {
  flex: none;
}
</style>
