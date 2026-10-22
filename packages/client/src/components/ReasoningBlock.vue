<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { formatThinkSeconds } from '../lib/thinking'

/**
 * 思考过程（契约 §6.8-1 reasoning_content）。
 * - 思考中：扫光文字“思考中 · 6 秒”（每秒走表），下面 2–3 行淡出的实时预览，跟随最新内容滚动；
 *   模型没有 reasoning_content 时也显示“思考中”直到第一个正文 token（取代旧的三个点）
 * - 结束：自动折叠为“已思考 12 秒”，点开平滑展开全文
 * - 用时只在本次运行内可知；刷新后服务端没有用时数据，只显示“已思考 · N 字”
 * - 尊重“减少动画”（系统 prefers-reduced-motion 与 设置 → 外观 → 减少动画）
 */
const props = withDefaults(
  defineProps<{
    text: string
    /** 仍在思考（还没有正文） */
    live?: boolean
    /** 本次思考开始时间（ms，用于走表） */
    startedAt?: number | null
    /** 已结束的思考用时（ms）；未知为 null */
    durationMs?: number | null
  }>(),
  { live: false, startedAt: null, durationMs: null },
)

const open = ref(false)
const now = ref(Date.now())
let timer = 0
function tick(): void {
  now.value = Date.now()
}
watch(
  () => props.live,
  (live) => {
    window.clearInterval(timer)
    if (live) {
      tick()
      timer = window.setInterval(tick, 250)
    } else {
      // 思考结束：自动折叠
      open.value = false
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => window.clearInterval(timer))

const elapsed = computed(() => (props.startedAt ? Math.max(0, now.value - props.startedAt) : 0))
const chars = computed(() => props.text.length)

/** 本次运行内知道用时：“已思考 12 秒”；刷新后没有用时：“已思考 · 65 字” */
const doneLabel = computed(() => {
  if (props.durationMs !== null && props.durationMs !== undefined) {
    return t('reasoningBlock.thoughtFor', [formatThinkSeconds(props.durationMs)])
  }
  return chars.value
    ? `${t('reasoningBlock.thought')} · ${t('reasoningBlock.chars', [chars.value])}`
    : t('reasoningBlock.thought')
})

/** 实时预览：只取最后一段，避免长推理每帧重排整段文字 */
const preview = computed(() => {
  const text = props.text.trimEnd()
  return text.length > 600 ? text.slice(-600) : text
})
const previewEl = ref<HTMLElement | null>(null)
watch(preview, async () => {
  await nextTick()
  const el = previewEl.value
  if (el) el.scrollTop = el.scrollHeight
})

const hasBody = computed(() => chars.value > 0)
</script>

<template>
  <div class="reasoning" :class="{ live, open }" data-testid="thinking">
    <button
      type="button"
      class="reasoning-head"
      :aria-expanded="live ? undefined : open"
      :disabled="live || !hasBody"
      @click="open = !open"
    >
      <span v-if="live" class="reasoning-live" role="status" aria-live="polite">
        <span class="shimmer">{{ $t('reasoningBlock.thinking') }}</span>
        <span v-if="startedAt && elapsed >= 1000" class="reasoning-time" data-testid="thinking-elapsed"
          >· {{ $t('reasoningBlock.seconds', [formatThinkSeconds(elapsed)]) }}</span
        >
      </span>
      <template v-else>
        <svg class="reasoning-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="reasoning-label" data-testid="thinking-done">{{ doneLabel }}</span>
        <svg v-if="hasBody" class="reasoning-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 4.5 6 7.5l3-3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </template>
    </button>

    <div v-if="live && hasBody" ref="previewEl" class="reasoning-preview" aria-hidden="true">{{ preview }}</div>

    <div v-if="!live && hasBody" class="reasoning-collapse" :class="{ open }">
      <div class="reasoning-inner">
        <div class="reasoning-body" :tabindex="open ? 0 : -1">{{ text }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reasoning {
  align-self: stretch;
  max-width: 100%;
  margin: 2px 0 2px;
}
.reasoning-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 8px;
  margin-left: -8px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.reasoning-head:disabled {
  cursor: default;
}
.reasoning-head:not(:disabled):hover {
  background: var(--hover-overlay);
}
.reasoning-head:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.reasoning-icon {
  color: var(--icon-muted);
  flex: none;
}
.reasoning-live {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
/* 扫光：渐变在文字上横向扫过 */
.shimmer {
  font-weight: 500;
  color: var(--text-secondary);
  background: linear-gradient(
    100deg,
    var(--text-tertiary) 0%,
    var(--text-tertiary) 35%,
    var(--text) 50%,
    var(--text-tertiary) 65%,
    var(--text-tertiary) 100%
  );
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: think-shimmer 1.8s linear infinite;
}
@keyframes think-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -150% 0;
  }
}
.reasoning-time {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.reasoning-chevron {
  color: var(--text-tertiary);
  transition: transform 0.2s ease;
}
.open .reasoning-chevron {
  transform: rotate(180deg);
}
/* 实时预览：最多 3 行，顶部淡出，跟随最新内容 */
.reasoning-preview {
  margin: 2px 0 2px 2px;
  padding-left: 10px;
  border-left: 2px solid var(--line-strong);
  max-height: calc(13px * 1.6 * 3);
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-tertiary);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 70%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 70%);
}
/* 平滑展开：grid 行高 0fr → 1fr */
.reasoning-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.24s ease;
}
.reasoning-collapse.open {
  grid-template-rows: 1fr;
}
.reasoning-inner {
  min-height: 0;
  overflow: hidden;
}
.reasoning-body {
  margin: 4px 0 4px 2px;
  padding-left: 10px;
  border-left: 2px solid var(--line-strong);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary);
  -webkit-user-select: text;
  user-select: text;
}
.reasoning-collapse:not(.open) .reasoning-body {
  visibility: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .shimmer {
    animation: none;
    -webkit-text-fill-color: currentColor;
    background: none;
  }
  .reasoning-collapse,
  .reasoning-chevron {
    transition: none;
  }
}
:global(html.reduce-motion) .shimmer {
  animation: none;
  -webkit-text-fill-color: currentColor;
  background: none;
}
:global(html.reduce-motion) .reasoning-collapse,
:global(html.reduce-motion) .reasoning-chevron {
  transition: none;
}
</style>
