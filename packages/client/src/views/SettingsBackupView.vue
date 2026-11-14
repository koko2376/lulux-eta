<script setup lang="ts">
import PermNote from '../components/ui/PermNote.vue'
import { computed, onMounted, ref } from 'vue'
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
/** 上一次导入的完整结果：表计数 + 导入前快照 + 已应用 / 已跳过的设置键名 */
const lastImport = ref<api.DataImportResult | null>(null)
/** 已应用 / 已跳过的键名列表是否展开（长列表默认收起） */
const showApplied = ref(false)
const showSkipped = ref(false)
/** 键名一次最多列这么多，再长就靠“展开全部” */
const LIST_PREVIEW = 6
const fileInput = ref<HTMLInputElement | null>(null)

// 只列真正导入了数据的表；全部为 0 时由下方“没有导入任何数据”兜底
const importedCounts = computed(() => Object.entries(lastImport.value?.imported ?? {}).filter(([, n]) => n > 0))
const appliedSettings = computed(() => lastImport.value?.appliedSettings ?? [])
const skippedSettings = computed(() => lastImport.value?.skippedSettings ?? [])
/** 只有真的应用 / 跳过了设置才显示设置那两栏（空结果不渲染空面板） */
const hasSettingsResult = computed(() => appliedSettings.value.length > 0 || skippedSettings.value.length > 0)

function visible(list: string[], expanded: boolean): string[] {
  return expanded ? list : list.slice(0, LIST_PREVIEW)
}

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
    // 服务端返回全量结果：表计数、导入前快照、已应用 / 已跳过的设置键名
    lastImport.value = await api.importData(payload)
    showApplied.value = false
    showSkipped.value = false
    toast.success(t('settingsBackup.kwoar18'))
    await Promise.all([load(), store.refreshSessions().catch(() => undefined)])
  } catch (error) {
    // 导入被拒（格式不对 / 没权限）：报出来，不动上一次的结果面板，也不留半截状态
    toast.error(errorText(error))
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

const TABLE_LABEL_KEY: Record<string, string> = {
  settings: 'settingsBackup.tableSettings',
  providers: 'settingsBackup.tableProviders',
  sessions: 'settingsBackup.k10gw4cu',
  messages: 'settingsBackup.k1p5t14q',
  customers: 'settingsBackup.k1v5iwp2',
  prospects: 'settingsBackup.tableProspects',
  activities: 'settingsBackup.klhkzqt',
  products: 'settingsBackup.ku6n7te',
  quotes: 'settingsBackup.k1py8dnr',
  inquiryRules: 'settingsBackup.tableInquiryRules',
  quoteTemplates: 'settingsBackup.tableQuoteTemplates',
  tasks: 'settingsBackup.tableTasks',
  deals: 'settingsBackup.tableDeals',
  orders: 'settingsBackup.tableOrders',
  payments: 'settingsBackup.tablePayments',
  memory: 'settingsBackup.tableMemory',
}
// 未知表名（新版服务端多出来的表）原样显示键名，不吞掉
const tableLabel = (key: string): string => (TABLE_LABEL_KEY[key] ? t(TABLE_LABEL_KEY[key]) : key)
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
            <!-- 导入结果：表计数 + 已应用 / 已跳过的设置键名；只显示键名，不显示任何设置值 -->
            <div v-if="lastImport" class="import-result" role="status" data-testid="import-result">
              <div class="import-result-head">
                <b>{{ $t('settingsBackup.importResultHead') }}</b>
                <span v-for="[key, n] in importedCounts" :key="key" class="import-count">
                  {{ $t('settingsBackup.importCount', [tableLabel(key), n]) }}
                </span>
                <span v-if="!importedCounts.length" class="import-count">{{ $t('settingsBackup.importNothing') }}</span>
              </div>
              <div v-if="hasSettingsResult" class="import-settings">
                <div v-if="appliedSettings.length" class="import-group" data-testid="import-applied">
                  <div class="import-group-head">
                    {{ $t('settingsBackup.importApplied', [appliedSettings.length]) }}
                  </div>
                  <ul class="import-keys">
                    <li v-for="key in visible(appliedSettings, showApplied)" :key="key" class="code">{{ key }}</li>
                  </ul>
                  <button
                    v-if="appliedSettings.length > LIST_PREVIEW"
                    type="button"
                    class="link"
                    @click="showApplied = !showApplied"
                  >
                    {{ showApplied ? $t('settingsBackup.importShowLess') : $t('settingsBackup.importShowAll', [appliedSettings.length]) }}
                  </button>
                </div>
                <div v-if="skippedSettings.length" class="import-group bad" data-testid="import-skipped">
                  <div class="import-group-head">
                    {{ $t('settingsBackup.importSkipped', [skippedSettings.length]) }}
                  </div>
                  <ul class="import-keys">
                    <li v-for="key in visible(skippedSettings, showSkipped)" :key="key" class="code">{{ key }}</li>
                  </ul>
                  <button
                    v-if="skippedSettings.length > LIST_PREVIEW"
                    type="button"
                    class="link"
                    @click="showSkipped = !showSkipped"
                  >
                    {{ showSkipped ? $t('settingsBackup.importShowLess') : $t('settingsBackup.importShowAll', [skippedSettings.length]) }}
                  </button>
                  <p class="import-why">{{ $t('settingsBackup.importSkippedWhy') }}</p>
                </div>
              </div>
              <p v-if="lastImport.backup" class="import-backup">
                {{ $t('settingsBackup.importBackupFile') }}: <span class="code">{{ lastImport.backup }}</span>
              </p>
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
/* 导入结果：表计数一行，设置项分“已应用 / 已跳过”两组，键名用等宽字 */
.import-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--surface-soft);
}
.import-result-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.import-result-head b {
  color: var(--text);
  font-weight: 600;
}
.import-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.import-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.import-group-head {
  font-size: 12.5px;
  font-weight: 600;
}
.import-group.bad .import-group-head {
  color: var(--danger);
}
.import-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.import-keys li {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--surface-muted);
}
.import-group.bad .import-keys li {
  color: var(--text);
}
.import-why,
.import-backup {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.import-group .link {
  align-self: flex-start;
  font-size: 11.5px;
}
</style>
