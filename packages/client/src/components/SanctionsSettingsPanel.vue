<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import * as api from '../api'
import { formatDate } from '../lib/labels'
import { can } from '../lib/session'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import UiSwitch from './ui/UiSwitch.vue'

/**
 * 设置 → 内置工具 → 制裁名单：OFAC / 欧盟 / 联合国名单的条数与更新时间，手动更新、每天自动更新开关。
 * Agent 的 screen_sanctions / save_prospects 与表格导入都用这里下载的名单做初筛。
 */
const store = useAppStore()
const lists = ref<api.SanctionsListStatus[]>([])
const loading = ref(true)
const refreshing = ref(false)
const writable = computed(() => can('settings:write'))
const auto = computed({
  get: () => store.settings.sanctionsAutoUpdate === '1',
  set: (value: boolean) => void saveAuto(value),
})

const NAMES = computed<Record<string, string>>(() => ({
  ofac: t('sanctions.ofac'),
  eu: t('sanctions.eu'),
  un: t('sanctions.un'),
  custom: t('sanctions.custom'),
}))
const rows = computed(() =>
  ['ofac', 'eu', 'un'].map((list) => lists.value.find((item) => item.list === list) ?? { list, updatedAt: null, entryCount: 0, sourceUrl: '', error: null }),
)
const custom = computed(() => lists.value.find((item) => item.list === 'custom' && item.entryCount > 0))
const missing = computed(() => rows.value.some((row) => !row.entryCount))

async function load(): Promise<void> {
  loading.value = true
  try {
    lists.value = (await api.getSanctionsStatus()).lists
  } catch {
    /* 全局 toast */
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    const res = await api.refreshSanctions('all')
    lists.value = res.lists
    if (res.failed.length) toast.error(t('sanctions.partial', [res.failed.map((f) => NAMES.value[f.list] ?? f.list).join(', ')]))
    else toast.success(t('sanctions.updated'))
  } catch (error) {
    toast.error(errorText(error))
    void load()
  } finally {
    refreshing.value = false
  }
}

async function saveAuto(value: boolean): Promise<void> {
  try {
    await store.saveSettings({ sanctionsAutoUpdate: value ? '1' : '0' })
  } catch {
    /* 全局 toast */
  }
}
</script>

<template>
  <section class="panel" data-testid="sanctions-settings">
    <div class="panel-head">
      <div class="txt">
        <h2 class="panel-title">{{ $t('sanctions.title') }}</h2>
        <div class="panel-sub">{{ $t('sanctions.sub') }}</div>
      </div>
    </div>
    <div class="panel-body">
      <ul class="lists">
        <li v-for="row in rows" :key="row.list" class="list-row">
          <div class="list-name">
            <b>{{ NAMES[row.list] }}</b>
            <span v-if="row.error" class="err" :title="row.error">{{ $t('sanctions.failed', [row.error]) }}</span>
          </div>
          <span class="list-meta tnum">
            <template v-if="row.entryCount">{{ $t('sanctions.meta', [row.entryCount.toLocaleString(), row.updatedAt ? formatDate(row.updatedAt) : '—']) }}</template>
            <template v-else>{{ $t('sanctions.notDownloaded') }}</template>
          </span>
        </li>
        <li v-if="custom" class="list-row">
          <div class="list-name">
            <b>{{ NAMES.custom }}</b>
          </div>
          <span class="list-meta tnum">{{ $t('sanctions.customMeta', [custom.entryCount.toLocaleString()]) }}</span>
        </li>
      </ul>
      <p v-if="!loading && missing" class="hint warn">{{ $t('sanctions.missingHint') }}</p>
      <ul class="opt-list">
        <li class="opt">
          <div class="opt-text">
            <b>{{ $t('sanctions.auto') }}</b>
            <span>{{ $t('sanctions.autoHint') }}</span>
          </div>
          <UiSwitch v-model="auto" :label="$t('sanctions.auto')" :disabled="!writable" />
        </li>
      </ul>
      <div class="hstack">
        <button
          v-perm="'settings:write'"
          type="button"
          class="kbtn primary"
          data-testid="sanctions-refresh"
          :disabled="refreshing"
          @click="refresh"
        >
          {{ refreshing ? $t('sanctions.refreshing') : $t('sanctions.refresh') }}
        </button>
        <span class="hint">{{ $t('sanctions.disclaimer') }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.lists {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.list-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.list-row:last-child {
  border-bottom: 0;
}
.list-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.list-meta {
  color: var(--text-tertiary);
  font-size: 12.5px;
  white-space: nowrap;
}
.err {
  font-size: 12px;
  color: var(--danger, #d64545);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
.hint.warn {
  margin-bottom: 10px;
  color: var(--prs-amber, #a96512);
}
.hstack {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.tnum {
  font-variant-numeric: tabular-nums;
}
.opt-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}
.opt {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
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
</style>
