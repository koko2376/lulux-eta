<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Agent } from '../api'
import { agentName, agentTagline, kernelReasonText, unavailableAction } from '../lib/kernel'
import { t } from '../i18n'
import AgentAvatar from './AgentAvatar.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  x: number
  y: number
  agents: Agent[]
  currentId?: string | null
  /** 侧栏“+”：在内核列表下方给出“新建群聊”（群聊总是新会话） */
  allowGroup?: boolean
}>()

const emit = defineEmits<{
  select: [agentId: string]
  close: []
  'new-group': []
}>()

const router = useRouter()
/** 宽 252px；第三方内核行右侧可能有“去安装”，略放宽 */
const MENU_WIDTH = 268
const menu = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)

/** 只列内核：LULUX 在最前（默认），然后是各命令行内核（服务端顺序 = 内核管理页顺序） */
const kernels = computed(() => {
  const builtin = props.agents.filter((a) => a.kind !== 'kernel')
  return [...builtin, ...props.agents.filter((a) => a.kind === 'kernel')]
})

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
  // 打开浮层后直接打字：关闭浮层，把焦点还给输入框，这个字符照常输入
  if (
    event.key.length === 1 &&
    event.key !== ' ' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing
  ) {
    emit('close')
    document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')?.focus()
    return
  }
  if (event.key === 'Process' || event.isComposing) {
    emit('close')
    document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')?.focus()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const items = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('.kernel-row:not(:disabled)') ?? [])
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next].focus()
  }
}

onMounted(async () => {
  await nextTick()
  const height = menu.value?.offsetHeight ?? 300
  left.value = Math.max(12, Math.min(props.x, window.innerWidth - MENU_WIDTH - 12))
  top.value = Math.max(12, Math.min(props.y, window.innerHeight - height - 12))
  window.addEventListener('keydown', onKey)
  menu.value?.querySelector<HTMLButtonElement>('.kernel-row.checked, .kernel-row:not(:disabled)')?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 悬停提示：不可用时说明原因（行内始终显示一行说明） */
function rowTitle(agent: Agent): string {
  if (agent.available === false)
    return `${agentTagline(agent)} · ${kernelReasonText(agent.unavailableReason) || t('kernelMenu.k1gztg64')}`
  return agentTagline(agent)
}

function goFix(agent: Agent): void {
  emit('close')
  void router.push(unavailableAction(agent).to)
}
</script>

<template>
  <Teleport to="body">
    <div class="kernel-backdrop" @mousedown.self="emit('close')">
      <div
        ref="menu"
        class="kernel-menu"
        role="menu"
        :aria-label="$t('agx.kernelMenuTitle')"
        :style="{
          left: `${left}px`,
          top: `${top}px`,
          width: `${MENU_WIDTH}px`,
          maxHeight: 'calc(100vh - 24px)',
          overflowY: 'auto',
        }"
      >
        <!-- 一个标题“选择内核”，头像 + 名称 + 一行说明，当前项打勾；未安装的置灰并给“去安装” -->
        <p class="kernel-title">{{ agents.length ? $t('agx.kernelMenuTitle') : $t('kernelMenu.k11n3f53') }}</p>
        <div
          v-for="agent in kernels"
          :key="agent.id"
          class="kernel-item"
          :data-kernel="agent.kind === 'kernel' ? agent.kernelId : 'builtin'"
        >
          <button
            type="button"
            role="menuitemradio"
            :aria-checked="agent.id === currentId"
            class="kernel-row"
            :class="{ checked: agent.id === currentId }"
            :disabled="agent.available === false"
            :title="rowTitle(agent)"
            @click="emit('select', agent.id)"
          >
            <AgentAvatar :agent-id="agent.id" :size="28" />
            <span class="kernel-text">
              <strong>{{ agentName(agent) }}</strong>
              <span>{{ agentTagline(agent) }}</span>
            </span>
            <AppIcon v-if="agent.id === currentId" name="check" :size="16" class="kernel-check" />
          </button>
          <button v-if="agent.available === false" type="button" class="kernel-install" @click="goFix(agent)">
            {{ unavailableAction(agent).text }}
          </button>
        </div>
        <template v-if="allowGroup">
          <div class="kernel-divider" role="separator" />
          <button type="button" role="menuitem" class="kernel-row kernel-new-group" @click="emit('new-group')">
            <span class="kernel-group-icon"><AppIcon name="users" :size="16" /></span>
            <span class="kernel-text">
              <strong>{{ $t('newGroup.title') }}</strong>
              <span>{{ $t('newGroup.menuHint') }}</span>
            </span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.kernel-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--line);
}
.kernel-group-icon {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.kernel-row:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.kernel-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kernel-item .kernel-row {
  flex: 1;
  min-width: 0;
}
/* “去安装 / 去设置模型”与行并排，不再绝对定位盖在描述文字上 */
.kernel-install {
  flex: none;
  margin-right: 6px;
  white-space: nowrap;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: 12px;
  color: var(--text);
}
.kernel-install:hover {
  background: var(--surface-soft);
}
</style>
