<script setup lang="ts">
import { computed } from 'vue'

/** 分页（原版样式）：左侧「第 1–20 条，共 N 条」，右侧 上一页 / 页码（当前页黑底）/ 下一页 */
const props = defineProps<{ page: number; pageSize: number; total: number }>()
const emit = defineEmits<{ 'update:page': [page: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const to = computed(() => Math.min(props.total, props.page * props.pageSize))
/** 最多 5 个页码，当前页尽量居中；首尾不连续时用「…」 */
const nums = computed<Array<number | '…'>>(() => {
  const n = pages.value
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1)
  const start = Math.max(2, Math.min(props.page - 1, n - 4))
  const end = Math.min(n - 1, start + 2)
  const out: Array<number | '…'> = [1]
  if (start > 2) out.push('…')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < n - 1) out.push('…')
  out.push(n)
  return out
})
</script>

<template>
  <nav class="pager" :aria-label="$t('uiPager.k11xlf5j')">
    <span class="pager-info">{{ $t('uiPager.k1clw9zl', [from, to, total]) }}</span>
    <div class="pager-btns">
      <button type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">
        {{ $t('uiPager.k1dysy54') }}
      </button>
      <template v-for="(p, i) in nums" :key="`${p}-${i}`">
        <span v-if="p === '…'" class="gap" aria-hidden="true">…</span>
        <button
          v-else
          type="button"
          :class="{ on: p === page }"
          :aria-current="p === page ? 'page' : undefined"
          @click="p !== page && emit('update:page', p)"
        >
          {{ p }}
        </button>
      </template>
      <span class="sr-only">{{ page }} / {{ pages }}</span>
      <button type="button" :disabled="page >= pages" @click="emit('update:page', page + 1)">
        {{ $t('uiPager.ksr64df') }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.pager-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pager-btns button {
  min-width: 28px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.pager-btns button:hover:not(:disabled):not(.on) {
  color: var(--text);
  border-color: var(--text-tertiary);
}
.pager-btns button.on {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
}
.pager-btns button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.gap {
  padding: 0 2px;
}
</style>
