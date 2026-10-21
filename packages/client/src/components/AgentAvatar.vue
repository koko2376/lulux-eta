<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { agentAvatarSource } from '../lib/group-avatar'
import { useAppStore } from '../stores/app'

/** 单个 Agent 的头像；群聊用 GroupAvatar */
const props = withDefaults(
  defineProps<{
    agentId?: string | null
    size?: number
  }>(),
  { agentId: null, size: 40 },
)

const store = useAppStore()
const agent = computed(() => store.agents.find((item) => item.id === props.agentId) ?? null)
const failed = ref(false)
watch(
  () => agent.value?.avatar,
  () => (failed.value = false),
)

/**
 * 内核头像（原版）：Hermes / Pi / Codex / Claude Code 是角色 png，Gemini CLI / Qwen Code 是 svg 标志（放在方块里），
 * LULUX 是产品图标。未知内核用服务端给的 avatar；都没有或加载失败用产品图标。
 */
const source = computed(() => (agent.value ? agentAvatarSource(agent.value) : null))
const logo = computed(() => (source.value?.tile && !failed.value ? source.value.src : null))
const src = computed(() => {
  if (!source.value || failed.value) return '/icon.png'
  return source.value.src
})
const label = computed(() => agent.value?.name ?? 'LULUX ETA')
</script>

<template>
  <span
    class="agent-avatar"
    :class="{ unavailable: agent?.available === false, 'kernel-logo': Boolean(logo) }"
    :style="{ '--avatar-size': `${size}px` }"
    :title="label"
  >
    <img :src="src" :alt="label" draggable="false" @error="failed = true" />
  </span>
</template>

<!-- 不加 scoped、与原来在 agent.css 里的特异性一致；放在组件里是因为 agent.css 只随 Agent 页懒加载，
     技能 → 按 Agent 配置 首屏打开时头像没有尺寸，整张图撑满侧栏 -->
<style>
.agent-avatar {
  position: relative;
  flex: 0 0 auto;
  display: inline-block;
  width: var(--avatar-size, 40px);
  height: var(--avatar-size, 40px);
}
.agent-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  -webkit-user-select: none;
  user-select: none;
  pointer-events: none;
  filter: drop-shadow(0 1px 2px rgba(17, 17, 19, 0.16));
}
/* 命令行内核标志：与原版内核管理页一致的白底描边圆角方块 */
.agent-avatar.kernel-logo {
  border-radius: 28%;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.agent-avatar.kernel-logo img {
  position: absolute;
  inset: 22%;
  width: 56%;
  height: 56%;
  filter: none;
}
:root[data-theme='dark'] .agent-avatar.kernel-logo img {
  filter: invert(1);
}
.agent-avatar.unavailable img {
  filter: grayscale(1);
  opacity: 0.55;
}
</style>
