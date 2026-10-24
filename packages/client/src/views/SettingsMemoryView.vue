<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { formatDate } from '../lib/labels'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/** 设置 → 记忆：当前账号的长期记忆（契约 §6.12）。只读写自己的，所有角色都能管理自己的记忆。 */
const SECTIONS = ['profile', 'notes'] as const
type Section = (typeof SECTIONS)[number]

const state = ref<api.MemoryState | null>(null)
const loading = ref(true)
const loadError = ref('')
const savingPrefs = ref(false)
const drafts = reactive<Record<Section, string>>({ profile: '', notes: '' })
const adding = reactive<Record<Section, boolean>>({ profile: false, notes: false })
const editing = ref<{ id: string; content: string } | null>(null)
const busyId = ref('')

const entryMax = computed(() => state.value?.entryMax ?? 500)
const totalEntries = computed(() =>
  state.value ? state.value.profile.entries.length + state.value.notes.entries.length : 0,
)

function sectionOf(section: Section): api.MemorySectionState {
  return state.value![section]
}

function percent(section: Section): number {
  const s = sectionOf(section)
  return s.limit > 0 ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0
}

function barTone(section: Section): string {
  const p = percent(section)
  return p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''
}

const number = (n: number): string => n.toLocaleString()

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    state.value = await api.getMemory()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function setPref(key: 'enabled' | 'autoExtract' | 'groupMemory', value: boolean): Promise<void> {
  if (!state.value) return
  savingPrefs.value = true
  try {
    state.value = await api.updateMemorySettings({ [key]: value })
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    savingPrefs.value = false
  }
}

async function add(section: Section): Promise<void> {
  const content = drafts[section].trim()
  if (!content) return
  adding[section] = true
  try {
    const result = await api.addMemoryEntry(section, content)
    drafts[section] = ''
    toast.success(result.duplicate ? t('settingsMemory.duplicate') : t('settingsMemory.added'))
    state.value = await api.getMemory()
  } catch {
    /* 全局 toast 已提示（预算已满 / 疑似密钥等） */
  } finally {
    adding[section] = false
  }
}

function startEdit(entry: api.MemoryEntry): void {
  editing.value = { id: entry.id, content: entry.content }
}

async function saveEdit(): Promise<void> {
  const current = editing.value
  if (!current || !current.content.trim()) return
  busyId.value = current.id
  try {
    await api.updateMemoryEntry(current.id, current.content.trim())
    editing.value = null
    toast.success(t('settingsMemory.saved'))
    state.value = await api.getMemory()
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    busyId.value = ''
  }
}

async function remove(entry: api.MemoryEntry): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsMemory.deleteTitle'),
    message: `${t('settingsMemory.deleteMessage')}\n\n${entry.content}`,
    confirmText: t('settingsMemory.delete'),
    danger: true,
  })
  if (!ok) return
  busyId.value = entry.id
  try {
    await api.deleteMemoryEntry(entry.id)
    toast.success(t('settingsMemory.deleted'))
    state.value = await api.getMemory()
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    busyId.value = ''
  }
}

async function clearAll(): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsMemory.clearConfirmTitle'),
    message: t('settingsMemory.clearConfirmMessage', [totalEntries.value]),
    confirmText: t('settingsMemory.clear'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.clearMemory()
    toast.success(t('settingsMemory.cleared'))
    state.value = await api.getMemory()
  } catch {
    /* 全局 toast 已提示 */
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsMemory.title')" :sub="$t('settingsMemory.sub')" />
    <div class="doc">
      <div class="doc-inner">
        <StateBlock v-if="loading" state="loading" />
        <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
        <template v-else-if="state">
          <section class="panel" data-testid="memory-switches">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsMemory.switchesTitle') }}</h2>
                <div class="panel-sub">{{ $t('settingsMemory.privacy') }}</div>
              </div>
            </div>
            <div class="panel-body">
              <ul class="opt-list">
                <li class="opt">
                  <div class="opt-text">
                    <b>{{ $t('settingsMemory.enabled') }}</b>
                    <span>{{ $t('settingsMemory.enabledHint') }}</span>
                  </div>
                  <UiSwitch
                    :model-value="state.enabled"
                    :label="$t('settingsMemory.enabled')"
                    :disabled="savingPrefs"
                    data-testid="memory-enabled"
                    @update:model-value="setPref('enabled', $event)"
                  />
                </li>
                <li class="opt">
                  <div class="opt-text">
                    <b>{{ $t('settingsMemory.autoExtract') }}</b>
                    <span>{{ $t('settingsMemory.autoExtractHint') }}</span>
                  </div>
                  <UiSwitch
                    :model-value="state.autoExtract"
                    :label="$t('settingsMemory.autoExtract')"
                    :disabled="savingPrefs || !state.enabled"
                    data-testid="memory-auto-extract"
                    @update:model-value="setPref('autoExtract', $event)"
                  />
                </li>
                <li class="opt">
                  <div class="opt-text">
                    <b>{{ $t('settingsMemory.groupMemory') }}</b>
                    <span>{{ $t('settingsMemory.groupMemoryHint') }}</span>
                  </div>
                  <UiSwitch
                    :model-value="state.groupMemory"
                    :label="$t('settingsMemory.groupMemory')"
                    :disabled="savingPrefs || !state.enabled"
                    data-testid="memory-group"
                    @update:model-value="setPref('groupMemory', $event)"
                  />
                </li>
              </ul>
            </div>
          </section>

          <p v-if="!state.enabled" class="mem-off" role="status">{{ $t('settingsMemory.disabledNote') }}</p>

          <section
            v-for="section in SECTIONS"
            :key="section"
            class="panel"
            :class="{ dimmed: !state.enabled }"
            :data-testid="`memory-section-${section}`"
          >
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t(`settingsMemory.${section}`) }}</h2>
                <div class="panel-sub">{{ $t(`settingsMemory.${section}Sub`) }}</div>
              </div>
              <div class="usage">
                <span class="usage-text" data-testid="memory-usage">{{
                  $t('settingsMemory.usage', [number(sectionOf(section).used), number(sectionOf(section).limit)])
                }}</span>
                <div
                  class="progress-bar usage-bar"
                  :class="barTone(section)"
                  role="progressbar"
                  :aria-label="$t('settingsMemory.usageAria', [$t(`settingsMemory.${section}`)])"
                  :aria-valuenow="percent(section)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <i :style="{ width: `${percent(section)}%` }"></i>
                </div>
              </div>
            </div>
            <div class="panel-body">
              <p v-if="sectionOf(section).entries.length === 0" class="empty">{{ $t('settingsMemory.empty') }}</p>
              <ul v-else class="entries">
                <li
                  v-for="entry in sectionOf(section).entries"
                  :key="entry.id"
                  class="entry"
                  data-testid="memory-entry"
                >
                  <template v-if="editing?.id === entry.id">
                    <textarea
                      v-model="editing.content"
                      class="textarea"
                      rows="2"
                      :maxlength="entryMax"
                      :aria-label="$t('settingsMemory.edit')"
                      @keydown.enter.exact.prevent="saveEdit"
                      @keydown.esc="editing = null"
                    />
                    <div class="entry-actions">
                      <span class="count">{{
                        $t('settingsMemory.charCount', [editing.content.length, entryMax])
                      }}</span>
                      <button type="button" class="kbtn sm" @click="editing = null">
                        {{ $t('settingsMemory.cancel') }}
                      </button>
                      <button
                        type="button"
                        class="kbtn sm primary"
                        :disabled="busyId === entry.id || !editing.content.trim()"
                        @click="saveEdit"
                      >
                        {{ $t('settingsMemory.save') }}
                      </button>
                    </div>
                  </template>
                  <template v-else>
                    <div class="entry-main">
                      <p class="entry-text">{{ entry.content }}</p>
                      <div class="entry-meta">
                        <span class="src" :class="`src-${entry.source}`">{{
                          $t(`settingsMemory.source_${entry.source}`)
                        }}</span>
                        <span>{{ $t('settingsMemory.updatedAt', [formatDate(entry.updatedAt)]) }}</span>
                      </div>
                    </div>
                    <div class="entry-actions">
                      <button type="button" class="kbtn sm ghost" @click="startEdit(entry)">
                        {{ $t('settingsMemory.edit') }}
                      </button>
                      <button
                        type="button"
                        class="kbtn sm ghost danger"
                        :disabled="busyId === entry.id"
                        @click="remove(entry)"
                      >
                        {{ $t('settingsMemory.delete') }}
                      </button>
                    </div>
                  </template>
                </li>
              </ul>
              <form class="add-row" @submit.prevent="add(section)">
                <input
                  v-model="drafts[section]"
                  class="input"
                  :name="`memory-${section}`"
                  :maxlength="entryMax"
                  :placeholder="$t(`settingsMemory.addPlaceholder_${section}`)"
                  :aria-label="$t(`settingsMemory.${section}`)"
                  :data-testid="`memory-add-${section}`"
                />
                <button type="submit" class="kbtn" :disabled="adding[section] || !drafts[section].trim()">
                  {{ adding[section] ? $t('settingsMemory.adding') : $t('settingsMemory.add') }}
                </button>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsMemory.clearTitle') }}</h2>
                <div class="panel-sub">{{ $t('settingsMemory.clearSub') }}</div>
              </div>
              <button
                type="button"
                class="kbtn danger"
                :disabled="totalEntries === 0"
                data-testid="memory-clear"
                @click="clearAll"
              >
                {{ $t('settingsMemory.clear') }}
              </button>
            </div>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.opt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.opt {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
}
.opt + .opt {
  border-top: 1px solid var(--line);
}
.opt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.opt-text b {
  font-size: 13.5px;
  font-weight: 500;
}
.opt-text span {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.mem-off {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 12.5px;
}
.dimmed .entries,
.dimmed .empty {
  opacity: 0.6;
}
.usage {
  flex: 0 0 200px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.usage-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.usage-bar {
  width: 100%;
}
.usage-bar.warn i {
  background: var(--warn);
}
.usage-bar.bad i {
  background: var(--danger);
}
.empty {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.entries {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.entry {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
}
.entry + .entry {
  border-top: 1px solid var(--line);
}
.entry .textarea {
  flex: 1;
  min-width: 0;
}
.entry-main {
  flex: 1;
  min-width: 0;
}
.entry-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.entry-meta {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.src-agent,
.src-auto {
  color: var(--text-secondary);
}
.entry-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.count {
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.add-row {
  display: flex;
  gap: 8px;
}
.add-row .input {
  flex: 1;
  min-width: 0;
}
</style>
