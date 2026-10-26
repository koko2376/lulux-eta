<script setup lang="ts">
import { errorText, toast } from '../stores/ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { fetchDownload } from '../api/skills'
import { approvalTitle, approvalView } from '../lib/approval'
import { isMemoryTool } from '../api/memory'
import { t } from '../i18n'
import { useAppStore } from '../stores/app'

type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'denied'

const props = withDefaults(
  defineProps<{
    name: string
    server: string
    args: string
    status: ToolStatus
    result: string
    durationMs: number
    /** 等待确认时是否展示「允许 / 拒绝」按钮 */
    interactive?: boolean
    /** read = 只读（自动执行），write = 会修改数据 */
    risk?: 'read' | 'write'
    /** 审批卡片类型（skill_script / skill_install / skill_write / mcp_*），普通工具为 tool 或不传 */
    approvalKind?: string
    detail?: unknown
    /** false：不提供“本会话始终允许”（MCP 增删改、技能安装等） */
    canRemember?: boolean
  }>(),
  { canRemember: true, interactive: false, risk: undefined, approvalKind: undefined, detail: undefined },
)

const emit = defineEmits<{
  /** remember='session'：本会话内同名工具不再询问（契约 §6.2） */
  decide: [approved: boolean, remember?: 'session']
}>()

const open = ref(false)

const statusLabel = computed(() => {
  switch (props.status) {
    case 'pending':
      return t('toolTrace.kafztb5')
    case 'running':
      return t('toolTrace.k8o8mej')
    case 'done':
      return t('toolTrace.k1stfijm')
    case 'denied':
      return t('toolTrace.kl7zruv')
    default:
      return t('toolTrace.kh9nt60')
  }
})

const prettyArgs = computed(() => {
  if (!props.args.trim()) return ''
  try {
    return JSON.stringify(JSON.parse(props.args), null, 2)
  } catch {
    return props.args
  }
})

const special = computed(() => approvalView(props.approvalKind, props.detail, props.name))

/* 电脑操作审批卡的截图：接口要鉴权头，下载成 blob: URL 再显示；红点按截图像素换算成百分比 */
const shotSrc = ref('')
let shotObjectUrl = ''
watch(
  () => special.value?.shot?.url ?? '',
  async (url) => {
    if (shotObjectUrl) URL.revokeObjectURL(shotObjectUrl)
    shotObjectUrl = ''
    shotSrc.value = ''
    if (!url) return
    try {
      const objectUrl = URL.createObjectURL(await fetchDownload(url))
      if ((special.value?.shot?.url ?? '') !== url) {
        URL.revokeObjectURL(objectUrl)
        return
      }
      shotObjectUrl = objectUrl
      shotSrc.value = objectUrl
    } catch {
      shotSrc.value = ''
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (shotObjectUrl) URL.revokeObjectURL(shotObjectUrl)
})
function markerStyle(point: { x: number; y: number }): Record<string, string> {
  const shot = special.value?.shot
  if (!shot) return {}
  const left = Math.min(100, Math.max(0, (point.x / shot.width) * 100))
  const top = Math.min(100, Math.max(0, (point.y / shot.height) * 100))
  return { left: `${left}%`, top: `${top}%` }
}
const COMPUTER_TOOLS = [
  'computer_screenshot',
  'computer_click',
  'computer_move',
  'computer_drag',
  'computer_scroll',
  'computer_type',
  'computer_key',
  'computer_cursor',
]
/** 群聊工具：中文动作名；建群 / 发起讨论成功后给“打开群聊”按钮 */
const GROUP_TOOLS = ['list_group_options', 'create_group', 'update_group', 'post_to_group', 'delete_group']
const groupSessionId = computed(() => {
  if (props.status !== 'done' || !['create_group', 'update_group', 'post_to_group'].includes(props.name)) return null
  return /[（(]id: (ses_[A-Za-z0-9_-]+)[）)]/.exec(props.result)?.[1] ?? null
})
async function openGroup(): Promise<void> {
  const id = groupSessionId.value
  if (!id) return
  const store = useAppStore()
  if (!store.sessions.some((session) => session.id === id)) await store.refreshSessions().catch(() => undefined)
  await store.selectSession(id).catch((error) => toast.error(errorText(error)))
}
const BROWSER_TOOLS = [
  ...COMPUTER_TOOLS,
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_scroll',
  'browser_screenshot',
  'browser_read',
  'browser_wait',
  'browser_back',
  'browser_tabs',
]
const title = computed(() => {
  if (isMemoryTool(props.name) || GROUP_TOOLS.includes(props.name)) return t(`toolTrace.${props.name}`)
  // 内置浏览器工具：中文动作名（审批卡片仍用卡片标题）
  if (BROWSER_TOOLS.includes(props.name) && (!props.approvalKind || props.approvalKind === 'tool'))
    return t(`toolTrace.${props.name}`)
  return approvalTitle(props.approvalKind, props.name)
})

/** 行内的简短参数：取前两个标量值（如 12.5*400），过长截断 */
const shortArgs = computed(() => {
  const raw = props.args.trim()
  if (!raw) return ''
  let text = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>)
        .filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
        .slice(0, 2)
        .map(String)
      text = values.length ? values.join(' · ') : ''
    }
  } catch {
    /* 非 JSON 参数原样显示 */
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
})

/** 记忆工具（memory_add / memory_replace / memory_remove）：不需要审批，不显示“写入”；成功后显示“已更新记忆” */
const memoryTool = computed(() => isMemoryTool(props.name))

const hasDetails = computed(() => Boolean(prettyArgs.value.trim()) || Boolean(props.result))

// 失败或拒绝时直接展开，方便看到原因
watch(
  () => props.status,
  (status) => {
    if (status === 'error' || status === 'denied') open.value = true
  },
)
</script>

<template>
  <div class="tool-trace" :class="[`is-${status}`, { open }]">
    <button type="button" class="tool-head" :aria-expanded="open" @click="open = !open">
      <span class="tool-dot" aria-hidden="true" />
      <span class="tool-name">{{ title }}</span>
      <span v-if="title !== name" class="tool-server">{{ name }}</span>
      <span v-else-if="server" class="tool-server">{{ server }}</span>
      <span v-if="shortArgs" class="tool-args" :title="shortArgs">{{ shortArgs }}</span>
      <span v-if="risk === 'write' && !memoryTool" class="tool-risk" :title="$t('toolTrace.kpt3ihu')">{{
        $t('toolTrace.k17zzdfw')
      }}</span>
      <span class="tool-state">{{ statusLabel }}</span>
      <span v-if="durationMs > 0" class="tool-time">{{ durationMs }} ms</span>
      <svg class="tool-chevron" :class="{ open }" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M3 4.5 6 7.5l3-3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div v-if="memoryTool && status === 'done'" class="memory-note" role="status" data-testid="memory-updated">
      <span class="memory-note-dot" aria-hidden="true" />
      {{ $t('toolTrace.memoryUpdated') }}
      <RouterLink class="memory-note-link" to="/settings/memory">{{ $t('toolTrace.memoryView') }}</RouterLink>
    </div>

    <div v-if="groupSessionId" class="memory-note group-note" role="status" data-testid="group-open">
      <span class="memory-note-dot" aria-hidden="true" />
      {{ name === 'post_to_group' ? $t('toolTrace.groupPosted') : $t('toolTrace.groupReady') }}
      <button type="button" class="memory-note-link group-open" @click="openGroup">
        {{ $t('toolTrace.groupOpen') }}
      </button>
    </div>

    <div v-if="special && (status === 'pending' || open)" class="approval-detail" :data-kind="approvalKind">
      <dl v-if="special.rows.length">
        <template v-for="row in special.rows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ code: row.code }">{{ row.value }}</dd>
        </template>
      </dl>
      <ul v-if="special.errors.length" class="approval-errors">
        <li v-for="e in special.errors" :key="e">{{ e }}</li>
      </ul>
      <div v-if="special.shot && shotSrc" class="computer-shot" data-testid="computer-shot">
        <img :src="shotSrc" :alt="$t('approval.computerShotAlt')" />
        <span v-if="special.shot.marker" class="computer-shot-marker" :style="markerStyle(special.shot.marker)" />
        <span v-if="special.shot.to" class="computer-shot-marker to" :style="markerStyle(special.shot.to)" />
      </div>
      <p v-for="w in special.warnings" :key="w" class="approval-warn">{{ w }}</p>
    </div>

    <div v-if="interactive && status === 'pending'" class="tool-actions">
      <button type="button" class="tool-btn approve" @click="emit('decide', true)">
        {{ $t('toolTrace.kl3m225') }}
      </button>
      <button
        v-if="canRemember !== false"
        type="button"
        class="tool-btn remember"
        :title="$t('toolTrace.kjc06pp', [name])"
        @click="emit('decide', true, 'session')"
      >
        {{ $t('toolTrace.k48cjnd') }}
      </button>
      <button type="button" class="tool-btn deny" @click="emit('decide', false)">{{ $t('toolTrace.k12sbs6') }}</button>
    </div>

    <div v-if="open && hasDetails" class="tool-details">
      <div v-if="prettyArgs" class="tool-block">
        <span class="tool-block-label">{{ $t('toolTrace.kwcu2xe') }}</span>
        <pre>{{ prettyArgs }}</pre>
      </div>
      <div v-if="result" class="tool-block">
        <span class="tool-block-label">{{ $t('toolTrace.k2tmjm6') }}</span>
        <pre>{{ result }}</pre>
      </div>
    </div>
  </div>
</template>
