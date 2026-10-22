<script setup lang="ts">
import { computed } from 'vue'
import { parseDoc } from '../lib/markdown-doc'
import InlineText from './InlineText.vue'

/** 文档预览（SKILL.md）：结构化渲染，不用 v-html */
const props = defineProps<{ content: string }>()
const blocks = computed(() => parseDoc(props.content))
</script>

<template>
  <div class="doc-md">
    <template v-for="(b, i) in blocks" :key="i">
      <component :is="`h${Math.min(b.level + 1, 6)}`" v-if="b.kind === 'heading'" class="doc-h" :class="`l${b.level}`">
        <InlineText :inlines="b.inlines" />
      </component>
      <p v-else-if="b.kind === 'para'" class="doc-p"><InlineText :inlines="b.inlines" /></p>
      <component :is="b.ordered ? 'ol' : 'ul'" v-else-if="b.kind === 'list'" class="doc-list">
        <li v-for="(item, j) in b.items" :key="j"><InlineText :inlines="item" /></li>
      </component>
      <div v-else-if="b.kind === 'table'" class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th v-for="(c, j) in b.head" :key="j"><InlineText :inlines="c" /></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, j) in b.rows" :key="j">
              <td v-for="(c, k) in r" :key="k"><InlineText :inlines="c" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <blockquote v-else-if="b.kind === 'quote'" class="doc-quote"><InlineText :inlines="b.inlines" /></blockquote>
      <pre v-else-if="b.kind === 'code'" class="doc-code"><code>{{ b.code }}</code></pre>
      <hr v-else class="doc-hr" />
    </template>
  </div>
</template>

<style scoped>
.doc-md {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text);
}
.doc-h {
  margin: 18px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}
.doc-h:first-child {
  margin-top: 0;
}
.doc-h.l1 {
  font-size: 18px;
}
.doc-h.l2 {
  font-size: 15.5px;
}
.doc-h.l3,
.doc-h.l4,
.doc-h.l5,
.doc-h.l6 {
  font-size: 14px;
}
.doc-p {
  margin: 0 0 10px;
  white-space: pre-wrap;
}
.doc-list {
  margin: 0 0 10px;
  padding-left: 22px;
}
.doc-list li + li {
  margin-top: 3px;
}
.doc-table-wrap {
  overflow-x: auto;
  margin: 0 0 12px;
}
.doc-table {
  border-collapse: collapse;
  font-size: 12.5px;
  min-width: 100%;
}
.doc-table th,
.doc-table td {
  border: 1px solid var(--line);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
.doc-table th {
  background: var(--surface-muted, #f4f4f5);
  font-weight: 600;
}
.doc-quote {
  margin: 0 0 10px;
  padding: 4px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-secondary);
  white-space: pre-wrap;
}
.doc-code {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hover-overlay);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre;
}
.doc-hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 14px 0;
}
:deep(.md-code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.86em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--hover-overlay);
}
</style>
