<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { catalogProviders } from '../lib/models'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import {
  Handle,
  MarkerType,
  Position,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type Node,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { ApiError } from '../api'
import {
  workflowCounts,
  workflowsApi,
  type RunStatus,
  type Workflow,
  type WorkflowNode,
  type WorkflowRun,
} from '../api/workflows'
import ScheduleDialog from '../components/schedule/ScheduleDialog.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import RunHistoryPanel from '../components/workflow/RunHistoryPanel.vue'
import SessionPeekModal from '../components/workflow/SessionPeekModal.vue'
import WorkflowNodeCard from '../components/workflow/WorkflowNodeCard.vue'
import { downloadJson } from '../lib/download'
import { can } from '../lib/session'
import {
  applyNodeEvent,
  blankWorkflow,
  hasEdge,
  isActive,
  newNode,
  snapshot,
  statusLabel,
  uid,
  wouldCreateCycle,
} from '../lib/workflow'
import { useAppStore } from '../stores/app'
import { onAutomationEvent } from '../stores/automation-events'
import { confirmDialog, errorText, toast, toastError } from '../stores/ui'
import { t } from '../i18n'

/**
 * 工作流：左侧列表（名称、节点 / 连线数、新建、搜索），中间画布（节点卡片 + 连线，缩放 / 适应 / 锁定 + 小地图），
 * 顶栏：新增节点、导入、导出、定时、运行历史、保存、运行；右侧运行历史（各节点状态 / 输出 / 隐藏会话）。
 * 修改先留在本地，保存时整体 PATCH；运行前有未保存修改会先保存。
 */
const route = useRoute()
const router = useRouter()
const store = useAppStore()
/** 新建 / 修改 / 删除工作流需要 workflow:manage；运行只需要 data:write */
const canWrite = computed(() => can('data:write') && can('workflow:manage'))
const canRun = computed(() => can('data:write'))

const workflows = ref<Workflow[]>([])
const listLoading = ref(true)
const listError = ref('')
const q = ref('')
const current = ref<Workflow | null>(null)
const loadingOne = ref(false)
const oneError = ref('')
const savedSnap = ref('')
const saving = ref(false)

const runs = ref<WorkflowRun[]>([])
const runsLoading = ref(false)
const runsError = ref('')
const historyOpen = ref(false)
const selectedRunId = ref<string | null>(null)
/** 画布上显示哪次运行的节点状态：刚发起 / 在运行历史里选中的那次 */
const focusRunId = ref<string | null>(null)

const routeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return k ? workflows.value.filter((w) => w.name.toLowerCase().includes(k)) : workflows.value
})
const dirty = computed(() => Boolean(current.value) && snapshot(current.value!) !== savedSnap.value)

/* ───────── 画布 ───────── */
const FLOW_ID = 'lulux-workflow'
const {
  onConnect,
  onNodesChange,
  onEdgesChange,
  onNodeDragStop,
  addNodes,
  removeNodes,
  fitView,
  setViewport,
  getViewport,
  screenToFlowCoordinate,
  onPaneReady,
} = useVueFlow(FLOW_ID)
const flowNodes = shallowRef<Node[]>([])
const flowEdges = shallowRef<Edge[]>([])
const canvasEl = ref<HTMLElement | null>(null)
let paneReady = false

const focusRun = computed(() => runs.value.find((r) => r.id === focusRunId.value) ?? null)
const statusMap = computed<Record<string, RunStatus>>(() => {
  const out: Record<string, RunStatus> = {}
  for (const n of focusRun.value?.nodes ?? []) out[n.nodeId] = n.status
  return out
})
const upstream = computed(() => new Set((current.value?.edges ?? []).map((e) => e.target)))
const running = computed(() => runs.value.some((r) => isActive(r.status)))

function flowNode(n: WorkflowNode): Node {
  return { id: n.id, type: 'agent', position: { ...n.position }, data: { node: n }, dragHandle: '.wf-node-head' }
}
function edgeView(id: string, source: string, target: string): Edge {
  const s = statusMap.value[source]
  const tg = statusMap.value[target]
  const live = s === 'succeeded' && tg === 'running'
  return {
    id,
    source,
    target,
    type: 'default',
    animated: live,
    class: live ? 'wf-edge live' : s === 'succeeded' && tg === 'succeeded' ? 'wf-edge done' : 'wf-edge',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  }
}
function syncEdges(): void {
  flowEdges.value = (current.value?.edges ?? []).map((e) => {
    const prev = flowEdges.value.find((x) => x.id === e.id)
    return {
      ...edgeView(e.id, e.source, e.target),
      selected: (prev as { selected?: boolean } | undefined)?.selected ?? false,
    }
  })
}
watch(statusMap, syncEdges)

async function buildFlow(): Promise<void> {
  const w = current.value
  flowNodes.value = w ? w.nodes.map(flowNode) : []
  flowEdges.value = []
  // 连线要等节点进了 Vue Flow 再给，否则找不到端点被丢掉
  await nextTick()
  syncEdges()
  await nextTick()
  if (paneReady) fitOrRestore()
}
function fitOrRestore(): void {
  const vp = current.value?.viewport
  if (vp && Number.isFinite(vp.zoom) && vp.zoom > 0) void setViewport(vp)
  else void fitView({ padding: 0.2, maxZoom: 1 })
}
onPaneReady(() => {
  paneReady = true
  fitOrRestore()
})

function isValidConnection(c: Connection): boolean {
  const w = current.value
  if (!w) return false
  // Vue Flow 也会拿已有连线来校验：已保存的连线照常显示
  const id = (c as Connection & { id?: string }).id
  if (id && w.edges.some((e) => e.id === id)) return true
  if (!canWrite.value) return false
  return !wouldCreateCycle(w.edges, c.source, c.target) && !hasEdge(w.edges, c.source, c.target)
}
onConnect((c) => {
  const w = current.value
  if (!w || !c.source || !c.target) return
  if (wouldCreateCycle(w.edges, c.source, c.target)) {
    toast.error(t('workflow.errCycle'))
    return
  }
  if (hasEdge(w.edges, c.source, c.target)) return
  w.edges.push({ id: uid('edge'), source: c.source, target: c.target })
  syncEdges()
})
onEdgesChange((changes) => {
  const w = current.value
  if (!w) return
  const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
  if (removed.size) w.edges = w.edges.filter((e) => !removed.has(e.id))
})
onNodesChange((changes) => {
  const w = current.value
  if (!w) return
  const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
  if (!removed.size) return
  w.nodes = w.nodes.filter((n) => !removed.has(n.id))
  w.edges = w.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target))
  syncEdges()
})
onNodeDragStop(({ nodes }) => {
  const w = current.value
  if (!w) return
  for (const fn of nodes) {
    const n = w.nodes.find((x) => x.id === fn.id)
    if (n) n.position = { x: Math.round(fn.position.x), y: Math.round(fn.position.y) }
  }
})

function patchNode(id: string, patch: Partial<WorkflowNode>): void {
  const n = current.value?.nodes.find((x) => x.id === id)
  if (n) Object.assign(n, patch)
}
function removeNode(id: string): void {
  removeNodes([id])
}
function addNode(): void {
  const w = current.value
  if (!w) return
  const r = canvasEl.value?.getBoundingClientRect()
  const center = r ? screenToFlowCoordinate({ x: r.left + r.width / 2, y: r.top + r.height / 3 }) : { x: 120, y: 120 }
  const k = w.nodes.length % 6
  const node = newNode(w.nodes, { x: Math.round(center.x - 124 + k * 28), y: Math.round(center.y - 60 + k * 28) })
  w.nodes.push(node)
  addNodes([flowNode(node)])
}

/* ───────── 列表 / 加载 ───────── */
async function loadList(): Promise<void> {
  listLoading.value = true
  listError.value = ''
  try {
    workflows.value = await workflowsApi.list(true)
  } catch (e) {
    listError.value = errorText(e)
  } finally {
    listLoading.value = false
  }
}

async function loadCurrent(id: string): Promise<void> {
  if (!id) {
    current.value = null
    flowNodes.value = []
    flowEdges.value = []
    return
  }
  loadingOne.value = true
  oneError.value = ''
  runs.value = []
  selectedRunId.value = null
  focusRunId.value = null
  try {
    const w = await workflowsApi.get(id, true)
    w.nodes = (w.nodes ?? []).map((n) => ({
      ...n,
      providerId: n.providerId ?? null,
      model: n.model ?? null,
      joinStrategy: n.joinStrategy ?? 'all',
      allowWrite: Boolean(n.allowWrite),
      position: n.position ?? { x: 0, y: 0 },
    }))
    w.edges = w.edges ?? []
    current.value = w
    savedSnap.value = snapshot(w)
    await buildFlow()
    void loadRuns(true)
  } catch (e) {
    current.value = null
    oneError.value = errorText(e)
  } finally {
    loadingOne.value = false
  }
}

async function loadRuns(pickActive = false): Promise<void> {
  const w = current.value
  if (!w) return
  runsLoading.value = true
  runsError.value = ''
  try {
    const list = await workflowsApi.runs(w.id, 20, true)
    if (current.value?.id !== w.id) return
    runs.value = list
    // 进入时有正在跑的运行：画布直接显示它的进度
    if (pickActive && !focusRunId.value) {
      const live = list.find((r) => isActive(r.status))
      if (live) focusRunId.value = live.id
    }
  } catch (e) {
    runsError.value = errorText(e)
  } finally {
    runsLoading.value = false
  }
}

watch(routeId, (id) => void loadCurrent(id))

/** 节点模型下拉的分组：优先用模型列表接口，旧服务端没有时退回 Provider 列表 */
const nodeProviders = computed(() => catalogProviders(store.modelCatalogs.builtin ?? null) ?? store.providers)

onMounted(async () => {
  await Promise.all([
    loadList(),
    store.agents.length ? Promise.resolve() : store.refreshAgents().catch(() => undefined),
    store.providers.length ? Promise.resolve() : store.refreshProviders().catch(() => undefined),
    // 节点的模型下拉与输入框的模型选择器共用 GET /api/models（契约 §6.13）
    store.loadModels('builtin', true).catch(() => null),
  ])
  if (routeId.value) await loadCurrent(routeId.value)
  else if (workflows.value[0]) await router.replace(`/workflows/${workflows.value[0].id}`)
})

/* ───────── 未保存修改 ───────── */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true
  return confirmDialog({
    title: t('workflow.discardTitle'),
    message: t('workflow.discardMessage', [current.value?.name ?? '']),
    confirmText: t('workflow.discard'),
    danger: true,
  })
}
onBeforeRouteUpdate(async (to, from) => {
  if (to.params.id === from.params.id) return true
  return confirmDiscard()
})
onBeforeRouteLeave(() => confirmDiscard())
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (dirty.value) e.preventDefault()
}

/* ───────── 保存 / 新建 / 复制 / 删除 / 重命名 ───────── */
function applyToList(w: Workflow): void {
  const i = workflows.value.findIndex((x) => x.id === w.id)
  const row = { ...w, nodeCount: w.nodes?.length ?? w.nodeCount, edgeCount: w.edges?.length ?? w.edgeCount }
  if (i >= 0) workflows.value[i] = { ...workflows.value[i], ...row }
  else workflows.value = [row, ...workflows.value]
}

async function save(): Promise<boolean> {
  const w = current.value
  if (!w || !canWrite.value) return false
  saving.value = true
  try {
    const vp = getViewport()
    const saved = await workflowsApi.update(
      w.id,
      { name: w.name, nodes: w.nodes, edges: w.edges, viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } },
      true,
    )
    w.updatedAt = saved.updatedAt ?? Date.now()
    w.viewport = saved.viewport ?? { x: vp.x, y: vp.y, zoom: vp.zoom }
    savedSnap.value = snapshot(w)
    applyToList({ ...w })
    return true
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CYCLE_DETECTED') toast.error(t('workflow.errCycle'))
    else toastError(e)
    return false
  } finally {
    saving.value = false
  }
}
async function saveWithToast(): Promise<void> {
  if (await save()) toast.success(t('workflow.saved'))
}

async function createWorkflow(): Promise<void> {
  if (!canWrite.value) return
  const n = workflows.value.length + 1
  try {
    const w = await workflowsApi.create(blankWorkflow(t('workflow.defaultName', [n])))
    applyToList(w)
    await router.push(`/workflows/${w.id}`)
  } catch {
    /* toast 已由 request 弹出 */
  }
}

const menuFor = ref<string | null>(null)
function closeMenu(): void {
  menuFor.value = null
}
async function duplicate(w: Workflow): Promise<void> {
  closeMenu()
  try {
    const copy = await workflowsApi.duplicate(w.id)
    applyToList(copy)
    await router.push(`/workflows/${copy.id}`)
  } catch {
    /* toast */
  }
}
async function remove(w: Workflow): Promise<void> {
  closeMenu()
  const ok = await confirmDialog({
    title: t('workflow.deleteTitle'),
    message: t('workflow.deleteMessage', [w.name]),
    confirmText: t('workflow.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await workflowsApi.remove(w.id)
    workflows.value = workflows.value.filter((x) => x.id !== w.id)
    if (current.value?.id === w.id) {
      savedSnap.value = snapshot(current.value)
      const next = workflows.value[0]
      await router.replace(next ? `/workflows/${next.id}` : '/workflows')
    }
    toast.success(t('workflow.deleted'))
  } catch {
    /* toast */
  }
}

const renaming = ref<{ id: string; name: string } | null>(null)
function startRename(w: Workflow): void {
  closeMenu()
  renaming.value = { id: w.id, name: w.name }
}
async function commitRename(): Promise<void> {
  const r = renaming.value
  if (!r) return
  const name = r.name.trim()
  if (!name) return
  try {
    const saved = await workflowsApi.update(r.id, { name })
    if (current.value?.id === r.id) {
      // 只改名：本地其它未保存修改保留，快照里同步新名字
      const wasDirty = dirty.value
      current.value.name = name
      if (!wasDirty) savedSnap.value = snapshot(current.value)
    }
    applyToList({ ...(workflows.value.find((x) => x.id === r.id) ?? saved), name })
    renaming.value = null
  } catch {
    /* toast */
  }
}

/* ───────── 导入 / 导出 ───────── */
const importInput = ref<HTMLInputElement | null>(null)
async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let json: unknown
  try {
    json = JSON.parse(await file.text())
  } catch {
    toast.error(t('workflow.importBad'))
    return
  }
  try {
    const w = await workflowsApi.importJson(json)
    applyToList(w)
    toast.success(t('workflow.imported', [w.name]))
    await router.push(`/workflows/${w.id}`)
  } catch {
    /* toast */
  }
}
async function exportCurrent(): Promise<void> {
  const w = current.value
  if (!w) return
  try {
    const data = await workflowsApi.exportJson(w.id)
    const safe = w.name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'workflow'
    downloadJson(data, `${safe}.lulux-workflow.json`)
  } catch {
    /* toast */
  }
}

/* ───────── 运行 ───────── */
const runDialog = ref(false)
const runInput = ref('')
const starting = ref(false)
async function startRun(): Promise<void> {
  const w = current.value
  if (!w) return
  if (!w.nodes.length) {
    toast.error(t('workflow.errEmpty'))
    return
  }
  starting.value = true
  try {
    if (dirty.value && !(await save())) return
    const run = await workflowsApi.run(w.id, runInput.value.trim() || undefined)
    runs.value = [run, ...runs.value.filter((r) => r.id !== run.id)]
    focusRunId.value = run.id
    selectedRunId.value = run.id
    historyOpen.value = true
    runDialog.value = false
    runInput.value = ''
  } catch {
    /* toast */
  } finally {
    starting.value = false
  }
}
async function cancelRun(runId: string): Promise<void> {
  try {
    const run = await workflowsApi.cancelRun(runId)
    upsertRun(run)
  } catch {
    /* toast */
  }
}
function upsertRun(run: WorkflowRun): void {
  const i = runs.value.findIndex((r) => r.id === run.id)
  if (i >= 0) runs.value[i] = run
  else runs.value = [run, ...runs.value]
}
function selectRun(id: string | null): void {
  selectedRunId.value = id
  if (id) focusRunId.value = id
}

let offEvents: (() => void) | null = null
let poll = 0
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('keydown', onKey)
  offEvents = onAutomationEvent((ev) => {
    if (ev.type === 'workflow.node') {
      const i = runs.value.findIndex((r) => r.id === ev.runId)
      if (i >= 0) runs.value[i] = applyNodeEvent(runs.value[i], ev)
      return
    }
    if (ev.type !== 'workflow.run') return
    const row = workflows.value.find((w) => w.id === ev.workflowId)
    if (row) row.lastRun = { id: ev.runId, status: ev.status, startedAt: row.lastRun?.startedAt ?? Date.now() }
    if (ev.workflowId !== current.value?.id) return
    const i = runs.value.findIndex((r) => r.id === ev.runId)
    if (i < 0) {
      // 定时任务等别处发起的运行：刷新列表，画布跟上它
      void loadRuns().then(() => {
        if (!focusRunId.value || !isActive(focusRun.value?.status)) focusRunId.value = ev.runId
      })
      return
    }
    runs.value[i] = { ...runs.value[i], status: ev.status }
    if (!isActive(ev.status)) void refreshRun(ev.runId)
  })
  // 兜底：事件流断开时，正在运行的那次每 4 秒静默刷新一次
  poll = window.setInterval(() => {
    for (const r of runs.value) if (isActive(r.status)) void refreshRun(r.id)
  }, 4000)
})
async function refreshRun(id: string): Promise<void> {
  try {
    upsertRun(await workflowsApi.getRun(id, true))
  } catch {
    /* 静默 */
  }
}
onBeforeUnmount(() => {
  offEvents?.()
  window.clearInterval(poll)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onKey)
})
function onKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (dirty.value && !saving.value) void saveWithToast()
  }
}

/* ───────── 定时 / 会话 ───────── */
const scheduleOpen = ref(false)
const peek = ref<{ sessionId: string; title: string } | null>(null)
async function openSchedule(): Promise<void> {
  if (dirty.value && !(await save())) return
  if (!store.sessions.length) await store.refreshSessions().catch(() => undefined)
  scheduleOpen.value = true
}
function onScheduleSaved(): void {
  scheduleOpen.value = false
}

const counts = (w: Workflow) => workflowCounts(w)
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('workflow.title')" @click="closeMenu">
      <div class="side-head">
        <h2 class="side-title">{{ $t('workflow.title') }}</h2>
      </div>
      <div class="wf-side-actions">
        <button v-if="canWrite" type="button" class="nav-row wf-new" data-testid="workflow-new" @click="createWorkflow">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {{ $t('workflow.new') }}
        </button>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('workflow.search') }}</span>
        <input v-model="q" type="search" :placeholder="$t('workflow.search')" spellcheck="false" />
      </label>
      <nav class="side-body" data-testid="workflow-list">
        <StateBlock v-if="listLoading && !workflows.length" state="loading" compact />
        <StateBlock v-else-if="listError" state="error" :message="listError" compact @retry="loadList" />
        <p v-else-if="!filtered.length" class="wf-side-empty">
          {{ q ? $t('workflow.noMatch') : $t('workflow.emptyList') }}
        </p>
        <div
          v-for="w in filtered"
          :key="w.id"
          class="wf-item"
          :class="{ on: w.id === routeId }"
          data-testid="workflow-item"
        >
          <RouterLink class="wf-item-link" :to="`/workflows/${w.id}`">
            <span class="wf-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="6" cy="7" r="2.4" />
                <circle cx="18" cy="7" r="2.4" />
                <circle cx="12" cy="17.5" r="2.4" />
                <path d="M8.2 8.3 10.6 15.4M15.8 8.3l-2.4 7.1" />
              </svg>
              <span
                v-if="w.lastRun && isActive(w.lastRun.status)"
                class="wf-live"
                :title="statusLabel(w.lastRun.status)"
              ></span>
            </span>
            <span class="wf-item-text">
              <span class="wf-item-name">{{ w.id === current?.id ? current.name : w.name }}</span>
              <span class="wf-item-sub">{{
                $t('workflow.counts', [
                  w.id === current?.id ? current.nodes.length : counts(w).nodes,
                  w.id === current?.id ? current.edges.length : counts(w).edges,
                ])
              }}</span>
            </span>
          </RouterLink>
          <button
            v-if="canWrite"
            type="button"
            class="wf-more"
            :aria-label="$t('workflow.more')"
            :aria-expanded="menuFor === w.id"
            @click.stop="menuFor = menuFor === w.id ? null : w.id"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="6" cy="12" r="1.4" />
              <circle cx="12" cy="12" r="1.4" />
              <circle cx="18" cy="12" r="1.4" />
            </svg>
          </button>
          <div v-if="menuFor === w.id" class="wf-menu" role="menu" @click.stop>
            <button v-perm="['data:write', 'workflow:manage']" type="button" role="menuitem" @click="startRename(w)">
              {{ $t('workflow.rename') }}
            </button>
            <button v-perm="['data:write', 'workflow:manage']" type="button" role="menuitem" @click="duplicate(w)">
              {{ $t('workflow.duplicate') }}
            </button>
            <button
              v-perm="['data:write', 'workflow:manage']"
              type="button"
              role="menuitem"
              class="danger"
              @click="remove(w)"
            >
              {{ $t('workflow.delete') }}
            </button>
          </div>
        </div>
      </nav>
    </aside>
  </SideSlot>

  <main class="main wf-main">
    <PageTopbar
      :title="current?.name ?? $t('workflow.title')"
      :sub="current ? $t('workflow.counts', [current.nodes.length, current.edges.length]) : undefined"
      :search="false"
      :ask="false"
    >
      <template v-if="current" #title-after>
        <span v-if="dirty" class="wf-dirty" data-testid="workflow-dirty">{{ $t('workflow.unsaved') }}</span>
      </template>
      <template v-if="current">
        <div class="wf-tools" role="toolbar" :aria-label="$t('workflow.toolbar')">
          <button v-if="canWrite" type="button" class="btn" data-testid="workflow-add-node" @click="addNode">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span class="lbl">{{ $t('workflow.addNode') }}</span>
          </button>
          <button
            v-if="canWrite"
            type="button"
            class="btn icon"
            :title="$t('workflow.import')"
            :aria-label="$t('workflow.import')"
            @click="importInput?.click()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
              <path d="M5 19.5h14" />
            </svg>
            <span>{{ $t('workflow.import') }}</span>
          </button>
          <button
            type="button"
            class="btn icon"
            :title="$t('workflow.export')"
            :aria-label="$t('workflow.export')"
            data-testid="workflow-export"
            @click="exportCurrent"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
              <path d="M5 19.5h14" />
            </svg>
            <span>{{ $t('workflow.export') }}</span>
          </button>
          <button
            v-if="canWrite"
            type="button"
            class="btn icon"
            :title="$t('workflow.schedule')"
            :aria-label="$t('workflow.schedule')"
            data-testid="workflow-schedule"
            @click="openSchedule"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <path d="M12 7.5V12l3 2" />
            </svg>
            <span>{{ $t('workflow.schedule') }}</span>
          </button>
          <button
            type="button"
            class="btn icon"
            :class="{ on: historyOpen }"
            :aria-pressed="historyOpen"
            :title="$t('workflow.history')"
            :aria-label="$t('workflow.history')"
            data-testid="workflow-history"
            @click="historyOpen = !historyOpen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
              <path d="M4.5 4.5v4h4M12 8v4.2l2.6 1.6" />
            </svg>
            <span>{{ $t('workflow.history') }}</span>
          </button>
          <button
            v-if="canWrite"
            type="button"
            class="btn"
            :disabled="!dirty || saving"
            data-testid="workflow-save"
            :title="$t('workflow.save')"
            :aria-label="saving ? $t('workflow.saving') : $t('workflow.save')"
            @click="saveWithToast"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4h9.4L19 7.1v11.4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5z" />
              <path d="M8.5 4v4.5h6V4M8 20v-5.5h8V20" />
            </svg>
            <span class="lbl">{{ saving ? $t('workflow.saving') : $t('workflow.save') }}</span>
          </button>
          <button
            v-if="canRun"
            type="button"
            class="btn dark"
            :disabled="starting"
            data-testid="workflow-run"
            :title="$t('workflow.run')"
            :aria-label="running ? $t('workflow.runAgain') : $t('workflow.run')"
            @click="runDialog = true"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M8 5.5v13l10.5-6.5z" /></svg>
            <span class="lbl">{{ running ? $t('workflow.runAgain') : $t('workflow.run') }}</span>
          </button>
        </div>
      </template>
    </PageTopbar>
    <input
      ref="importInput"
      type="file"
      accept="application/json,.json"
      class="sr-only"
      data-testid="workflow-import-input"
      @change="onImportFile"
    />

    <div class="wf-stage">
      <div ref="canvasEl" class="wf-canvas">
        <StateBlock v-if="loadingOne && !current" state="loading" />
        <StateBlock v-else-if="oneError" state="error" :message="oneError" @retry="loadCurrent(routeId)" />
        <StateBlock
          v-else-if="!current && !listLoading"
          state="empty"
          :title="$t('workflow.emptyTitle')"
          :message="$t('workflow.emptyMessage')"
        >
          <button v-if="canWrite" type="button" class="kbtn primary" @click="createWorkflow">
            {{ $t('workflow.new') }}
          </button>
        </StateBlock>
        <VueFlow
          v-show="current"
          :id="FLOW_ID"
          v-model:nodes="flowNodes"
          v-model:edges="flowEdges"
          class="wf-flow"
          :min-zoom="0.2"
          :max-zoom="1.6"
          :nodes-draggable="canWrite"
          :nodes-connectable="canWrite"
          :edges-updatable="false"
          :delete-key-code="canWrite ? ['Backspace', 'Delete'] : null"
          :is-valid-connection="isValidConnection"
          :default-edge-options="{ type: 'default' }"
          :connection-line-options="{ style: { strokeDasharray: '5 4' } }"
          fit-view-on-init
        >
          <template #node-agent="{ id, data, selected }">
            <Handle type="target" :position="Position.Left" class="wf-handle" />
            <WorkflowNodeCard
              :node="data.node"
              :agents="store.agents"
              :providers="nodeProviders"
              :status="statusMap[id] ?? null"
              :selected="selected"
              :readonly="!canWrite"
              :has-upstream="upstream.has(id)"
              @update="patchNode(id, $event)"
              @remove="removeNode(id)"
            />
            <Handle type="source" :position="Position.Right" class="wf-handle" />
          </template>
          <Background :gap="18" :size="1.2" pattern-color="var(--wf-dot)" />
          <Controls position="bottom-left" :show-interactive="true" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            :width="180"
            :height="120"
            node-color="var(--wf-mini-node)"
            mask-color="var(--wf-mini-mask)"
            :node-border-radius="6"
          />
        </VueFlow>
        <div v-if="current && !current.nodes.length" class="wf-canvas-empty">
          <p>{{ $t('workflow.canvasEmpty') }}</p>
          <button v-if="canWrite" type="button" class="kbtn" @click="addNode">{{ $t('workflow.addNode') }}</button>
        </div>
        <p v-if="current && current.nodes.length" class="wf-hint">{{ $t('workflow.canvasHint') }}</p>
      </div>

      <RunHistoryPanel
        v-if="current && historyOpen"
        :runs="runs"
        :nodes="current.nodes"
        :selected-id="selectedRunId"
        :loading="runsLoading"
        :error="runsError"
        @select="selectRun"
        @refresh="loadRuns()"
        @close="historyOpen = false"
        @cancel="cancelRun"
        @open-session="(sessionId, title) => (peek = { sessionId, title })"
      />
    </div>
  </main>

  <UiModal
    v-if="runDialog && current"
    :title="$t('workflow.runTitle', [current.name])"
    :subtitle="$t('workflow.runSub')"
    @close="runDialog = false"
  >
    <label class="field">
      <span class="field-label">{{ $t('workflow.runInput') }}</span>
      <textarea
        v-model="runInput"
        class="textarea"
        rows="4"
        :placeholder="$t('workflow.runInputPlaceholder')"
        data-testid="run-input"
        @keydown.enter.meta.prevent="startRun"
        @keydown.enter.ctrl.prevent="startRun"
      ></textarea>
    </label>
    <p v-if="dirty" class="field-hint wf-run-note">{{ $t('workflow.runSavesFirst') }}</p>
    <template #footer>
      <button type="button" class="kbtn" @click="runDialog = false">{{ $t('workflow.cancel') }}</button>
      <button type="button" class="kbtn primary" :disabled="starting" data-testid="run-confirm" @click="startRun">
        {{ starting ? $t('workflow.starting') : $t('workflow.run') }}
      </button>
    </template>
  </UiModal>

  <UiModal v-if="renaming" :title="$t('workflow.rename')" :width="420" @close="renaming = null">
    <label class="field">
      <span class="field-label">{{ $t('workflow.name') }}</span>
      <input
        v-model="renaming.name"
        class="input"
        maxlength="60"
        data-testid="rename-input"
        @keydown.enter="commitRename"
      />
    </label>
    <template #footer>
      <button type="button" class="kbtn" @click="renaming = null">{{ $t('workflow.cancel') }}</button>
      <button type="button" class="kbtn primary" :disabled="!renaming.name.trim()" @click="commitRename">
        {{ $t('workflow.save') }}
      </button>
    </template>
  </UiModal>

  <ScheduleDialog
    v-if="scheduleOpen && current"
    :prefill="{ targetType: 'workflow', workflowId: current.id }"
    :workflows="workflows"
    :agents="store.agents"
    :sessions="store.sessions"
    @close="scheduleOpen = false"
    @saved="onScheduleSaved"
  />
  <SessionPeekModal v-if="peek" :session-id="peek.sessionId" :title="peek.title" @close="peek = null" />
</template>

<style scoped>
.wf-side-actions {
  padding: 0 12px 4px;
}
.wf-new {
  color: var(--text);
}
.wf-new svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}
.wf-side-empty {
  padding: 18px 10px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
.wf-item {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--radius-md);
  margin-bottom: 2px;
}
.wf-item:hover {
  background: var(--surface-hover);
}
.wf-item.on {
  background: var(--surface-active);
}
.wf-item-link {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 4px 9px 10px;
  color: var(--text);
}
.wf-item-icon {
  position: relative;
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  color: var(--text-secondary);
}
.wf-item-icon svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
.wf-live {
  position: absolute;
  right: -2px;
  top: -2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--info-text);
  box-shadow: 0 0 0 2px var(--sidebar);
}
.wf-item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wf-item-name {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-item.on .wf-item-name {
  font-weight: 650;
}
.wf-item-sub {
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.wf-more {
  width: 28px;
  height: 28px;
  margin-right: 6px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--icon-muted);
  opacity: 0;
}
.wf-item:hover .wf-more,
.wf-item.on .wf-more,
.wf-more:focus-visible,
.wf-more[aria-expanded='true'] {
  opacity: 1;
}
.wf-more:hover {
  background: var(--surface);
  color: var(--text);
}
.wf-more svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}
.wf-menu {
  position: absolute;
  right: 6px;
  top: calc(100% - 4px);
  z-index: 20;
  min-width: 132px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
}
.wf-menu button {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.wf-menu button:hover {
  background: var(--surface-hover);
}
.wf-menu button.danger {
  color: var(--danger-text);
}

.wf-main {
  min-width: 0;
}
.wf-dirty {
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--surface-muted);
  font-size: 11px;
  color: var(--text-secondary);
}
.wf-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn.dark {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
  font-weight: 600;
}
.btn.dark:hover:not(:disabled) {
  background: var(--primary-hover);
}
.btn svg.fill {
  fill: currentColor;
  stroke: none;
}
.btn.on {
  background: var(--surface-active);
  color: var(--text);
}
.btn:hover:not(:disabled):not(.dark) {
  background: var(--surface-soft);
  color: var(--text);
}
@container topbar (max-width: 1080px) {
  .btn.icon span {
    display: none;
  }
}
/* 窗口再窄（1024 宽 + 125% 缩放）：新增节点也只留图标；仍放不下时工具栏可横向滑动，按钮不会被截掉 */
@container topbar (max-width: 860px) {
  .wf-tools .lbl {
    display: none;
  }
  .wf-tools .btn {
    padding-inline: 10px;
  }
  /* 放不下时运行、保存排最前，次要的导入导出/历史落到可滑动的后面 */
  .wf-tools .btn.dark,
  .wf-tools [data-testid='workflow-save'] {
    order: -1;
  }
}
.wf-tools {
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

/* 画布窄时缩略图会盖住节点，直接收起（缩放按钮够用） */
@container wfcanvas (max-width: 760px) {
  :deep(.vue-flow__minimap) {
    display: none;
  }
}
.wf-stage {
  flex: 1;
  min-height: 0;
  display: flex;
}
.wf-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  container: wfcanvas / inline-size;
  background: var(--window);
  --wf-dot: var(--line-strong);
  --wf-mini-node: var(--surface-active);
  --wf-mini-mask: color-mix(in srgb, var(--window) 70%, transparent);
}
.wf-flow {
  position: absolute;
  inset: 0;
}
.wf-canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  pointer-events: none;
  color: var(--text-tertiary);
  font-size: 13px;
}
.wf-canvas-empty button {
  pointer-events: auto;
}
.wf-hint {
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  margin: 0;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-tertiary);
  pointer-events: none;
  white-space: nowrap;
}
.wf-run-note {
  margin: 8px 0 0;
}

/* ── Vue Flow 主题：跟随 LULUX token（浅色 / 深色） ── */
.wf-flow :deep(.vue-flow__node) {
  border-radius: 14px;
}
.wf-flow :deep(.wf-handle) {
  /* 连接点固定在标题行高度：节点高矮不一时连线仍然水平对齐 */
  top: 45px;
  width: 11px;
  height: 11px;
  background: var(--surface);
  border: 1.5px solid var(--icon-muted);
}
.wf-flow :deep(.wf-handle:hover),
.wf-flow :deep(.vue-flow__handle.connecting) {
  border-color: var(--text);
  background: var(--text);
}
.wf-flow :deep(.vue-flow__edge-path) {
  stroke: var(--icon-muted);
  stroke-width: 1.6;
}
.wf-flow :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--text);
  stroke-width: 2.2;
}
.wf-flow :deep(.wf-edge.done .vue-flow__edge-path) {
  stroke: var(--good);
}
.wf-flow :deep(.wf-edge.live .vue-flow__edge-path) {
  stroke: var(--info-text);
  stroke-dasharray: 6 5;
}
.wf-flow :deep(.vue-flow__connection-path) {
  stroke: var(--text-secondary);
  stroke-width: 1.6;
}
.wf-flow :deep(.vue-flow__controls) {
  box-shadow: var(--shadow-2);
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.wf-flow :deep(.vue-flow__controls-button) {
  width: 32px;
  height: 32px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  color: var(--text);
}
.wf-flow :deep(.vue-flow__controls-button:hover) {
  background: var(--surface-hover);
}
.wf-flow :deep(.vue-flow__controls-button svg) {
  fill: currentColor;
  max-width: 13px;
  max-height: 13px;
}
.wf-flow :deep(.vue-flow__minimap) {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.wf-flow :deep(.vue-flow__panel) {
  margin: 16px;
}
</style>
