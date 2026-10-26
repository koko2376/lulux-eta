<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { renderMarkdown, type CodeLabels } from '../lib/markdown'
import { parseBlocks } from '../lib/markdown-lite'
import { openExternal } from '../lib/window'

/**
 * 气泡正文。markdown=true（助手消息）：完整 Markdown（标题、列表、表格、引用、链接、可折叠代码块），
 * 经 DOMPurify 净化；流式时最多每 60ms 重新渲染一次。否则（用户消息）：粗体、行内代码、代码块，纯文本为主。
 */
const props = defineProps<{ content: string; markdown?: boolean; streaming?: boolean }>()
const blocks = computed(() => (props.markdown ? [] : parseBlocks(props.content)))
const lines = (code: string) => code.split('\n').length

const codeLabels = (): CodeLabels => ({
  lines: (n) => t('messageContent.ki4yst7', [n]),
  title: (lang, n) => t('messageContent.k6nb7b6', [lang, n]),
  previewHint: t('messageContent.ki4t6se'),
})

const html = ref('')
const box = ref<HTMLElement | null>(null)
let timer: number | null = null
let lastRender = 0
const STREAM_INTERVAL = 60

/*
 * 流式中每次重新渲染都会整体替换 DOM：用户手动展开 / 收起过的代码块（按序号）记下来，
 * 渲染后恢复，不会被下一次增量渲染收回去。
 */
const userOpen = new Map<number, boolean>()
/** 上一次渲染出来时各代码块的默认展开状态 */
let renderedOpen: boolean[] = []

function codeBlocks(): HTMLDetailsElement[] {
  return box.value ? [...box.value.querySelectorAll<HTMLDetailsElement>('details.md-block')] : []
}

function captureToggles(): void {
  codeBlocks().forEach((block, index) => {
    if (index >= renderedOpen.length) return
    if (userOpen.has(index) || block.open !== renderedOpen[index]) userOpen.set(index, block.open)
  })
}

async function restoreToggles(): Promise<void> {
  await nextTick()
  const blocks = codeBlocks()
  renderedOpen = blocks.map((block) => block.open)
  blocks.forEach((block, index) => {
    const open = userOpen.get(index)
    if (open !== undefined) block.open = open
  })
}

let renderedContent = ''

function renderNow(): void {
  timer = null
  lastRender = Date.now()
  captureToggles()
  // 换成了另一段内容（不是在原文后面接着输出）：之前记下的展开状态不再适用
  if (!props.content.startsWith(renderedContent)) userOpen.clear()
  renderedContent = props.content
  const next = renderMarkdown(props.content, codeLabels(), { streaming: props.streaming })
  if (next === html.value) return
  html.value = next
  void restoreToggles()
}

watch(
  () => [props.content, props.markdown, props.streaming] as const,
  () => {
    if (!props.markdown) return
    if (!props.streaming) {
      if (timer !== null) window.clearTimeout(timer)
      renderNow()
      return
    }
    if (timer !== null) return
    const wait = Math.max(0, STREAM_INTERVAL - (Date.now() - lastRender))
    if (wait === 0) renderNow()
    else timer = window.setTimeout(renderNow, wait)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer)
})

/** 链接一律交给系统浏览器（桌面端）/ 新标签页，不在应用窗口里跳转 */
function onClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest?.('a')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) openExternal(href)
  else if (/^mailto:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown 输出经 DOMPurify 净化（lib/markdown.ts） -->
  <div v-if="markdown" ref="box" class="md" :class="{ 'is-streaming': streaming }" @click="onClick" v-html="html"></div>
  <template v-else>
    <template v-for="(block, i) in blocks" :key="i">
      <p v-if="block.kind === 'text'" class="md-p">
        <template v-for="(part, j) in block.inlines" :key="j">
          <strong v-if="part.kind === 'bold'">{{ part.text }}</strong>
          <code v-else-if="part.kind === 'code'" class="md-code">{{ part.text }}</code>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
      <details v-else class="md-block" :open="block.open || lines(block.code) <= 6">
        <summary :title="$t('messageContent.k6nb7b6', [block.lang, lines(block.code)])">
          <span class="md-lang">{{ block.lang }}</span> {{ $t('messageContent.ki4yst7', [lines(block.code)]) }}
          <span v-if="['html', 'svg'].includes(block.lang)" class="md-hint">{{ $t('messageContent.ki4t6se') }}</span>
        </summary>
        <pre><code>{{ block.code }}</code></pre>
      </details>
    </template>
  </template>
</template>

<style scoped>
/* ── Markdown（助手消息）：沿用气泡的字号与行高，段落间距 10px，与纯文本气泡观感一致 ── */
.md {
  white-space: normal;
}
/* 流式中：光标紧跟在最后一段文字后面 */
.md.is-streaming,
.md.is-streaming :deep(> p:last-child) {
  display: inline;
}
.md :deep(> :first-child) {
  margin-top: 0;
}
.md :deep(> :last-child) {
  margin-bottom: 0;
}
.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(blockquote),
.md :deep(.md-table),
.md :deep(.md-block),
.md :deep(pre.md-pre) {
  margin: 10px 0;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 14px 0 6px;
  font-weight: 650;
  line-height: 1.35;
}
.md :deep(h1) {
  font-size: 1.3em;
}
.md :deep(h2) {
  font-size: 1.18em;
}
.md :deep(h3) {
  font-size: 1.06em;
}
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  font-size: 1em;
}
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.4em;
}
.md :deep(li + li) {
  margin-top: 2px;
}
.md :deep(li > p) {
  margin: 0;
}
.md :deep(blockquote) {
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-secondary);
}
.md :deep(hr) {
  margin: 14px 0;
  border: 0;
  border-top: 1px solid var(--line);
}
.md :deep(a) {
  /* 链接：蓝色、无下划线，悬停才出下划线 */
  color: var(--link);
  text-decoration: none;
  text-underline-offset: 2px;
  cursor: pointer;
}
.md :deep(a:hover) {
  text-decoration: underline;
}
.md :deep(:not(pre) > code) {
  /* 行内代码：浅底细描边 + 红字 */
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--danger-text);
}
.md :deep(.md-table) {
  overflow-x: auto;
  border-radius: 12px;
  border: 1px solid var(--line);
}
.md :deep(table) {
  /* 列多时按内容撑开、整体横向滚动；长文字列在 24em 处换行，避免被挤成一字一行、行高暴涨 */
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  line-height: 1.5;
}
.md :deep(th),
.md :deep(td) {
  padding: 7px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.md :deep(td) {
  /* 窄对话栏里不要把短单元格（型号、数量）挤成一字一行：放不下时表格横向滚动 */
  min-width: 6em;
  max-width: 24em;
}
.md :deep(tr:last-child td) {
  border-bottom: 0;
}
.md :deep(th) {
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--hover-overlay);
  white-space: nowrap;
}
.md :deep(pre.md-pre) {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--hover-overlay);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow: auto;
}
.md :deep(.md-block) {
  border-radius: 12px;
  background: var(--hover-overlay);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}
.md :deep(.md-block summary) {
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.md :deep(.md-lang) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--text);
}
.md :deep(.md-hint) {
  margin-left: 6px;
}
.md :deep(.md-block pre) {
  margin: 0;
  padding: 0 12px 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.md-p {
  margin: 0;
  white-space: pre-wrap;
}
.md-p + .md-p,
.md-block + .md-p,
.md-p + .md-block,
.md-block + .md-block {
  margin-top: 10px;
}
.md-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.86em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--hover-overlay);
}
.md-block {
  border-radius: 12px;
  background: var(--hover-overlay);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}
.md-block summary {
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.md-lang {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
  color: var(--text);
}
.md-hint {
  margin-left: 6px;
}
.md-block pre {
  margin: 0;
  padding: 0 12px 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
