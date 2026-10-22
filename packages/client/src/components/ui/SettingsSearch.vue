<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { settingsGroups, type SettingsPage } from '../../lib/settings-pages'

/** 设置页顶栏的「搜索设置…」（设置页只有这一个灰色搜索框）：按设置页名称筛选，↑↓ 选择，回车打开。 */
const router = useRouter()
const q = ref('')
const open = ref(false)
const active = ref(0)

const hits = computed<SettingsPage[]>(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return []
  return settingsGroups()
    .flatMap((g) => g.items)
    .filter((p) => p.label.toLowerCase().includes(needle) || p.key.includes(needle))
})

function go(p: SettingsPage | undefined): void {
  open.value = false
  if (p) void router.push(p.to)
  q.value = ''
}
function onKey(e: KeyboardEvent): void {
  const n = hits.value.length
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault()
    active.value = (active.value + 1) % n
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault()
    active.value = (active.value - 1 + n) % n
  } else if (e.key === 'Enter') {
    e.preventDefault()
    go(hits.value[active.value])
  } else if (e.key === 'Escape') {
    open.value = false
    ;(e.target as HTMLInputElement).blur()
  }
}
function onInput(): void {
  open.value = true
  active.value = 0
}
function onBlur(): void {
  window.setTimeout(() => (open.value = false), 150)
}
</script>

<template>
  <div class="gsearch">
    <label class="search">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <input
        v-model="q"
        type="search"
        :placeholder="$t('shellx.settingsSearchPlaceholder')"
        :aria-label="$t('shellx.settingsSearchAria')"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        :aria-expanded="open && !!q.trim()"
        aria-controls="settings-search-list"
        @input="onInput"
        @focus="open = true"
        @blur="onBlur"
        @keydown="onKey"
      />
    </label>
    <div v-if="open && q.trim()" id="settings-search-list" class="gs-pop" role="listbox">
      <div v-if="!hits.length" class="gs-empty">{{ $t('shellx.noHits') }}</div>
      <button
        v-for="(h, i) in hits"
        :key="h.key"
        type="button"
        class="gs-row"
        role="option"
        :aria-selected="i === active"
        :class="{ on: i === active }"
        @mousedown.prevent="go(h)"
      >
        <b>{{ h.label }}</b>
      </button>
    </div>
  </div>
</template>

<style scoped>
.gsearch {
  position: relative;
  -webkit-app-region: no-drag;
}
.search input::-webkit-search-cancel-button {
  display: none;
}
.gs-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 280px;
  max-height: 360px;
  overflow: auto;
  z-index: 60;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
}
.gs-row {
  width: 100%;
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  font-size: 13px;
}
.gs-row b {
  font-weight: 500;
}
.gs-row:hover,
.gs-row.on {
  background: var(--surface-hover);
}
.gs-empty {
  padding: 12px 10px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
</style>
