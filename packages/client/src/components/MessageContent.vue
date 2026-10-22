<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
let timer: number | null = null
let lastRender = 0
const STREAM_INTERVAL = 60

function renderNow(): void {
  timer = null
  lastRender = Date.now()
  html.value = renderMarkdown(props.content, codeLabels(), { streaming: props.streaming })
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
  <div v-if="markdown" class="md" :class="{ 'is-streaming': streaming }" @click="onClick" v-html="html"></div>
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
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: var(--text-tertiary);
  cursor: pointer;
}
.md :deep(a:hover) {
  text-decoration-color: currentColor;
}
.md :deep(:not(pre) > code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.86em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--hover-overlay);
}
.md :deep(.md-table) {
  overflow-x: auto;
  border-radius: 12px;
  border: 1px solid var(--line);
}
.md :deep(table) {
  width: 100%;
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
