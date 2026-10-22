<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { Session } from '../api'
import { t } from '../i18n'
import { avatarHue, initialsOf } from '../lib/group-members'
import {
  agentAvatarSource,
  groupAvatarCells,
  groupAvatarLayout,
  groupAvatarMembers,
  type GroupAvatarCell,
} from '../lib/group-avatar'
import { auth } from '../lib/session'
import { useAppStore } from '../stores/app'

/**
 * 群聊头像：圆角方块里拼成员头像（主管在前，其次 Agent，再是同事）。
 * 2 人左右并排，3 人上 1 下 2，4 人 2×2，更多时前 3 个 + “+N”。
 */
const props = withDefaults(
  defineProps<{
    session: Pick<Session, 'agentIds' | 'supervisorId' | 'participants'>
    size?: number
  }>(),
  { size: 40 },
)

const store = useAppStore()
const failed = reactive<Record<string, boolean>>({})

const members = computed(() => groupAvatarMembers(props.session, auth.me?.user.id ?? null))
const cells = computed(() => groupAvatarCells(members.value))
const slots = computed(() => groupAvatarLayout(cells.value.length))

interface CellView {
  key: string
  kind: GroupAvatarCell['type']
  style: Record<string, string>
  label: string
  src?: string
  tile?: boolean
  unavailable?: boolean
  text?: string
  hue?: number
}

const views = computed<CellView[]>(() =>
  cells.value.map((cell, index) => {
    const slot = slots.value[index]
    const style = { left: `${slot.left}%`, top: `${slot.top}%`, width: `${slot.size}%`, height: `${slot.size}%` }
    if (cell.type === 'agent') {
      const agent = store.agents.find((a) => a.id === cell.id) ?? null
      const source = agentAvatarSource(agent)
      const key = `a:${cell.id}`
      return {
        key,
        kind: 'agent',
        style,
        label: agent?.name ?? 'LULUX ETA',
        src: failed[key] ? '/icon.png' : source.src,
        tile: source.tile && !failed[key],
        unavailable: agent?.available === false,
      }
    }
    if (cell.type === 'human') {
      return {
        key: `h:${cell.userId}`,
        kind: 'human',
        style,
        label: cell.name,
        text: initialsOf(cell.name),
        hue: avatarHue(cell.userId),
      }
    }
    return { key: 'more', kind: 'more', style, label: `+${cell.count}`, text: `+${cell.count}` }
  }),
)

const title = computed(() =>
  views.value
    .filter((v) => v.kind !== 'more')
    .map((v) => v.label)
    .join('、'),
)
const ariaLabel = computed(() => t('groupAvatar.label', [members.value.length]))
</script>

<template>
  <span
    class="group-avatar"
    :style="{ '--avatar-size': `${size}px` }"
    :title="title"
    role="img"
    :aria-label="ariaLabel"
    :data-count="members.length"
  >
    <span
      v-for="cell in views"
      :key="cell.key"
      class="group-avatar-cell"
      :class="[`is-${cell.kind}`, { 'kernel-logo': cell.tile, unavailable: cell.unavailable }]"
      :style="cell.hue != null ? { ...cell.style, '--avatar-hue': String(cell.hue) } : cell.style"
      :data-kind="cell.kind"
    >
      <img
        v-if="cell.kind === 'agent'"
        :src="cell.src"
        :alt="cell.label"
        draggable="false"
        @error="failed[cell.key] = true"
      />
      <template v-else>{{ cell.text }}</template>
    </span>
  </span>
</template>

<!-- 与 AgentAvatar 一样不加 scoped：侧栏首屏就要有尺寸 -->
<style>
.group-avatar {
  position: relative;
  flex: 0 0 auto;
  display: inline-block;
  width: var(--avatar-size, 40px);
  height: var(--avatar-size, 40px);
  border-radius: 28%;
  background: var(--surface-muted);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  overflow: hidden;
}
.group-avatar-cell {
  position: absolute;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  -webkit-user-select: none;
  user-select: none;
}
.group-avatar-cell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  filter: drop-shadow(0 0.5px 1px rgba(17, 17, 19, 0.18));
}
/* 命令行内核标志：白底描边小方块 */
.group-avatar-cell.kernel-logo {
  border-radius: 28%;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.group-avatar-cell.kernel-logo img {
  width: 62%;
  height: 62%;
  filter: none;
}
:root[data-theme='dark'] .group-avatar-cell.kernel-logo img {
  filter: invert(1);
}
.group-avatar-cell.unavailable img {
  filter: grayscale(1);
  opacity: 0.55;
}
:root[data-theme='dark'] .group-avatar-cell.kernel-logo.unavailable img {
  filter: invert(1) grayscale(1);
}
.group-avatar-cell.is-human,
.group-avatar-cell.is-more {
  border-radius: 50%;
  font-size: max(7px, calc(var(--avatar-size, 40px) * 0.19));
  font-weight: 650;
  line-height: 1;
  letter-spacing: 0;
}
.group-avatar-cell.is-human {
  background: hsl(var(--avatar-hue) 46% 88%);
  color: hsl(var(--avatar-hue) 42% 30%);
}
:root[data-theme='dark'] .group-avatar-cell.is-human {
  background: hsl(var(--avatar-hue) 26% 30%);
  color: hsl(var(--avatar-hue) 50% 84%);
}
.group-avatar-cell.is-more {
  background: var(--surface-active);
  color: var(--text-secondary);
  font-size: max(7px, calc(var(--avatar-size, 40px) * 0.17));
}
</style>
