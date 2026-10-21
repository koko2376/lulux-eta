<script setup lang="ts">
import PermNote from '../components/ui/PermNote.vue'
import { onMounted, ref } from 'vue'
import * as api from '../api'
import BackupSnapshots from '../components/BackupSnapshots.vue'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import { downloadJson, formatBytes, stamp } from '../lib/download'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const store = useAppStore()
const summary = ref<api.DataSummary | null>(null)
const loading = ref(true)
const loadError = ref('')
const exporting = ref(false)
const importing = ref(false)
const clearing = ref(false)
const lastImport = ref<Record<string, number> | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    summary.value = await api.getDataSummary()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function doExport(): Promise<void> {
  exporting.value = true
  try {
    const data = await api.exportData()
    downloadJson(data, `lulux-backup-${stamp()}.json`)
    toast.success(t('settingsBackup.k1pcr8q'))
  } finally {
    exporting.value = false
  }
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let payload: unknown
  try {
    payload = JSON.parse(await file.text())
  } catch {
    toast.error(t('settingsBackup.kp2tcmh'))
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    toast.error(t('settingsBackup.kmwerqw'))
    return
  }
  const ok = await confirmDialog({
    title: t('settingsBackup.k1vju9t6', [file.name]),
    message: t('settingsBackup.k1ihypzz'),
    confirmText: t('settingsBackup.kqvrict'),
  })
  if (!ok) return
  importing.value = true
  try {
    const { imported } = await api.importData(payload)
    lastImport.value = imported
    toast.success(t('settingsBackup.kwoar18'))
    await Promise.all([load(), store.refreshSessions().catch(() => undefined)])
  } finally {
    importing.value = false
  }
}

async function clearSessions(): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsBackup.ktqw867'),
    message: t('settingsBackup.ku5hjwl', [summary.value?.sessions ?? 0, summary.value?.messages ?? 0]),
    confirmText: t('settingsBackup.k14mkkaw'),
    danger: true,
    typeToConfirm: t('settingsBackup.k10wdk3x'),
  })
  if (!ok) return
  clearing.value = true
  try {
    const { removed } = await api.clearAllSessions()
    toast.success(t('settingsBackup.k1patqlt', [removed]))
    await Promise.all([load(), store.refreshSessions().catch(() => undefined)])
  } finally {
    clearing.value = false
  }
}

const TABLE_LABEL: Record<string, string> = {
  customers: t('settingsBackup.k1v5iwp2'),
  quotes: t('settingsBackup.k1py8dnr'),
  sessions: t('settingsBackup.k10gw4cu'),
  messages: t('settingsBackup.k1p5t14q'),
  products: t('settingsBackup.ku6n7te'),
  activities: t('settingsBackup.klhkzqt'),
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsBackup.k14ecx9c')" :sub="$t('settingsBackup.kqm0f45')" />
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="data:export" :text="$t('settingsBackup.k672red')" />
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsBackup.k1l6wa9d') }}</h2>
              <div class="panel-sub">{{ $t('settingsBackup.k1jdd3bi') }}</div>
            </div>
            <button type="button" class="kbtn" :disabled="loading" @click="load">
              {{ $t('settingsBackup.kfk0ip6') }}
            </button>
          </div>
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <div v-else-if="summary" class="stats">
            <div>
              <span>{{ $t('settingsBackup.k10gw4cu') }}</span
              ><b>{{ summary.sessions }}</b>
            </div>
            <div>
              <span>{{ $t('settingsBackup.k1p5t14q') }}</span
              ><b>{{ summary.messages }}</b>
            </div>
            <div>
              <span>Provider</span><b>{{ summary.providers }}</b>
            </div>
            <div>
              <span>{{ $t('settingsBackup.kjhoedj') }}</span
              ><b>{{ summary.mcpServers }}</b>
            </div>
            <div>
              <span>{{ $t('settingsBackup.k1txcnrx') }}</span
              ><b>{{ formatBytes(summary.databaseBytes) }}</b>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsBackup.khwph8w') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsBackup.k5xny6g') }}
              </div>
            </div>
          </div>
          <div class="panel-body stack">
            <div class="hstack">
              <button v-perm="'data:export'" type="button" class="kbtn primary" :disabled="exporting" @click="doExport">
                {{ exporting ? $t('settingsBackup.kqfh01u') : $t('settingsBackup.k1m0pmkk') }}
              </button>
              <button
                v-perm="'data:import'"
                type="button"
                class="kbtn"
                :disabled="importing"
                @click="fileInput?.click()"
              >
                {{ importing ? $t('settingsBackup.k1povjjz') : $t('settingsBackup.kh7vfoq') }}
              </button>
              <input
                ref="fileInput"
                type="file"
                accept="application/json,.json"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
                @change="onFile"
              />
            </div>
            <div v-if="lastImport" class="note" role="status">
              {{ $t('settingsBackup.k1fxkgxk') }}
              <span v-for="(n, key) in lastImport" :key="key">{{
                $t('settingsBackup.ktapc78', [TABLE_LABEL[key] ?? key, n])
              }}</span>
            </div>
          </div>
        </section>

        <BackupSnapshots />

        <section class="panel danger-zone">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsBackup.k90ly3o') }}</h2>
              <div class="panel-sub">{{ $t('settingsBackup.k1cx0dy7') }}</div>
            </div>
            <button type="button" class="kbtn danger" :disabled="clearing || !summary?.sessions" @click="clearSessions">
              {{ clearing ? $t('settingsBackup.k1qtehk7') : $t('settingsBackup.ksysqpk') }}
            </button>
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}
.stats div {
  padding: 16px 20px;
  border-left: 1px solid var(--surface-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stats div:first-child {
  border-left: 0;
}
.stats span {
  font-size: 12px;
  color: var(--text-secondary);
}
.stats b {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.danger-zone .panel-head {
  border-bottom: 0;
}
</style>
