<script setup lang="ts">
import { computed } from 'vue'
import { isDesktopApp, isMac, shortcutRows } from '../lib/shortcuts'
import UiModal from './ui/UiModal.vue'

const emit = defineEmits<{ close: [] }>()
const rows = computed(() => shortcutRows(isMac(), isDesktopApp()))
</script>

<template>
  <UiModal :title="$t('shortcuts.helpTitle')" :width="460" @close="emit('close')">
    <table class="shortcut-table" data-testid="shortcuts-help">
      <tbody>
        <tr v-for="row in rows" :key="row.label">
          <th scope="row">{{ $t(row.label) }}</th>
          <td>
            <template v-for="(combo, i) in row.keys" :key="i">
              <span v-if="i > 0" class="or">{{ $t('shortcuts.or') }}</span>
              <span class="combo">
                <kbd v-for="k in combo" :key="k">{{ k }}</kbd>
              </span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="hint">{{ $t('shortcuts.typingHint') }}</p>
  </UiModal>
</template>

<style scoped>
.shortcut-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.shortcut-table th {
  text-align: left;
  font-weight: 400;
  padding: 7px 0;
  color: var(--text);
}
.shortcut-table td {
  text-align: right;
  white-space: nowrap;
  padding: 7px 0;
}
.shortcut-table tr + tr th,
.shortcut-table tr + tr td {
  border-top: 1px solid var(--line);
}
.combo {
  display: inline-flex;
  gap: 3px;
}
kbd {
  min-width: 22px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 5px;
  font:
    12px/18px ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  text-align: center;
  background: var(--bg-soft, transparent);
}
.or {
  margin: 0 6px;
  color: var(--muted);
  font-size: 12px;
}
.hint {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 12px;
}
</style>
