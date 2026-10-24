<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import { intlLocale, t } from '../i18n'
import { downloadBlob, formatBytes } from '../lib/download'
import { auth, can, currentRole } from '../lib/session'
import { confirmDialog, errorText, toast, toastError } from '../stores/ui'
import StateBlock from './ui/StateBlock.vue'

/**
 * 整库快照（契约 §10.5）：列表、手动快照、恢复（下次启动生效）、待恢复横幅（可取消）、上次恢复结果；
 * 备份目录（desktop 用文件夹选择框，server 填服务器路径，仅 owner）、自动备份间隔与保留份数、下载与删除。
 */
type Backup = api.BackupFile

const backups = ref<Backup[]>([])
const location = ref<api.BackupLocation | null>(null)
const dirInput = ref('')
const savingDir = ref(false)
const dirError = ref('')
const schedule = reactive({ hours: '24', keep: '7', loaded: false })
const savingSchedule = ref(false)
const isOwner = computed(() => currentRole.value === 'owner')
const canDelete = computed(() => can('data:export') && (currentRole.value === 'owner' || currentRole.value === 'admin'))
const canSchedule = computed(() => can('settings:write'))
/** 本机桌面版：有原生文件夹选择框 */
const folderPicker = computed(() =>
  auth.mode === 'desktop' && typeof window !== 'undefined' && typeof window.lulux?.pickFolder === 'function'
    ? window.lulux.pickFolder
    : null,
)
const HOURS_OPTIONS = computed(() => [
  { v: '0', l: t('backup.scheduleOff') },
  { v: '6', l: t('backup.scheduleHours', [6]) },
  { v: '12', l: t('backup.scheduleHours', [12]) },
  { v: '24', l: t('backup.scheduleDaily') },
  { v: '72', l: t('backup.scheduleDays', [3]) },
  { v: '168', l: t('backup.scheduleWeekly') },
])
const loading = ref(true)
const error = ref('')
const creating = ref(false)
const pending = ref<api.RestorePending | null>(null)
const lastResult = ref<api.RestoreResult | null>(null)
const busy = ref('')
const canExport = computed(() => can('data:export'))
const canImport = computed(() => can('data:import'))

const KIND_LABEL = computed<Record<string, string>>(() => ({
  auto: t('backup.kindAuto'),
  manual: t('backup.kindManual'),
  'before-import': t('backup.kindBeforeImport'),
  'before-restore': t('backup.kindBeforeRestore'),
  'pre-migration': t('backup.kindPreMigration'),
  other: t('backup.kindOther'),
}))

const fmt = (v: number | string) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(intlLocale(), { hour12: false })
}

async function loadState(): Promise<void> {
  try {
    const s = await api.restoreApi.state()
    pending.value = s.pending
    lastResult.value = s.lastResult
  } catch {
    /* 旧服务端没有恢复接口 */
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  void loadState()
  try {
    const res = await api.backupApi.list()
    backups.value = res.backups
    location.value = res.location ?? null
    if (location.value && !dirInput.value) dirInput.value = location.value.configuredDir ?? ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
async function loadSchedule(): Promise<void> {
  try {
    const settings = await api.listSettings()
    schedule.hours = settings.autoBackupHours ?? '24'
    schedule.keep = settings.autoBackupKeep ?? '7'
    schedule.loaded = true
  } catch {
    /* 没有读取设置的权限时不显示 */
  }
}
onMounted(() => {
  void load()
  void loadSchedule()
})

async function saveSchedule(): Promise<void> {
  const keep = Math.round(Number(schedule.keep))
  if (!Number.isFinite(keep) || keep < 1 || keep > 60) {
    toast.error(t('backup.keepInvalid'))
    return
  }
  savingSchedule.value = true
  try {
    const next = await api.updateSettings({ autoBackupHours: schedule.hours, autoBackupKeep: String(keep) })
    schedule.hours = next.autoBackupHours ?? schedule.hours
    schedule.keep = next.autoBackupKeep ?? String(keep)
    toast.success(t('backup.scheduleSaved'))
  } finally {
    savingSchedule.value = false
  }
}

async function applyDir(dir: string | null): Promise<void> {
  savingDir.value = true
  dirError.value = ''
  try {
    location.value = await api.backupApi.setLocation(dir)
    dirInput.value = location.value.configuredDir ?? ''
    toast.success(dir ? t('backup.dirSaved') : t('backup.dirReset'))
    await load()
  } catch (e) {
    dirError.value = errorText(e)
  } finally {
    savingDir.value = false
  }
}

async function pickDir(): Promise<void> {
  const picker = folderPicker.value
  if (!picker) return
  const dir = await picker({ title: t('backup.pickTitle'), defaultPath: location.value?.dir })
  if (dir) await applyDir(dir)
}

async function download(b: Backup): Promise<void> {
  busy.value = b.name
  try {
    downloadBlob(await api.backupApi.download(b.name), b.name)
  } finally {
    busy.value = ''
  }
}

async function remove(b: Backup): Promise<void> {
  const ok = await confirmDialog({
    title: t('backup.deleteTitle', [b.name]),
    message: t('backup.deleteMsg', [fmt(b.createdAt), formatBytes(b.size)]),
    confirmText: t('backup.deleteConfirm'),
    danger: true,
  })
  if (!ok) return
  busy.value = b.name
  try {
    await api.backupApi.remove(b.name)
    backups.value = backups.value.filter((x) => x.name !== b.name)
    toast.success(t('backup.deleted'))
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function snapshot(): Promise<void> {
  creating.value = true
  try {
    await api.backupApi.create()
    toast.success(t('backup.created'))
    await load()
  } finally {
    creating.value = false
  }
}

async function restore(b: Backup): Promise<void> {
  const ok = await confirmDialog({
    title: t('backup.restoreTitle', [b.name]),
    message: t('backup.restoreMsg', [fmt(b.createdAt)]),
    confirmText: t('backup.restoreConfirm'),
    danger: true,
  })
  if (!ok) return
  busy.value = b.name
  try {
    const res = await api.restoreApi.request(b.name)
    pending.value = res.pending
    toast.success(t('backup.restoreQueued'))
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function cancelRestore(): Promise<void> {
  busy.value = '__cancel'
  try {
    const res = await api.restoreApi.cancel()
    pending.value = null
    toast.success(res.cancelled ? t('backup.restoreCancelled') : t('backup.nothingPending'))
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="panel" data-testid="backup-snapshots">
    <div class="panel-head">
      <div class="txt">
        <h2 class="panel-title">{{ $t('backup.title') }}</h2>
        <div class="panel-sub">{{ $t('backup.sub') }}</div>
      </div>
      <button
        v-if="canExport"
        type="button"
        class="kbtn"
        :disabled="creating"
        data-testid="snapshot-now"
        @click="snapshot"
      >
        {{ creating ? $t('backup.creating') : $t('backup.create') }}
      </button>
    </div>

    <div v-if="location" class="settings-block" data-testid="backup-location">
      <div class="row-item">
        <div class="grow">
          <div class="t">{{ $t('backup.dirTitle') }}</div>
          <div class="d mono" data-testid="backup-dir">{{ location.dir }}</div>
        </div>
        <template v-if="isOwner">
          <button
            v-if="folderPicker"
            type="button"
            class="kbtn sm"
            :disabled="savingDir"
            data-testid="backup-dir-pick"
            @click="pickDir"
          >
            {{ $t('backup.dirChoose') }}
          </button>
          <button
            v-if="location.configuredDir"
            type="button"
            class="kbtn sm"
            :disabled="savingDir"
            data-testid="backup-dir-reset"
            @click="applyDir(null)"
          >
            {{ $t('backup.dirUseDefault') }}
          </button>
        </template>
      </div>
      <form v-if="isOwner && !folderPicker" class="dir-form" @submit.prevent="applyDir(dirInput.trim() || null)">
        <input
          v-model="dirInput"
          class="input mono"
          :placeholder="$t('backup.dirPlaceholder')"
          :aria-label="$t('backup.dirTitle')"
          spellcheck="false"
          data-testid="backup-dir-input"
        />
        <button type="submit" class="kbtn sm" :disabled="savingDir" data-testid="backup-dir-save">
          {{ $t('backup.dirSave') }}
        </button>
      </form>
      <p v-if="!isOwner" class="field-hint">{{ $t('backup.dirOwnerOnly') }}</p>
      <p v-if="dirError" class="field-error" role="alert">{{ dirError }}</p>
      <div v-if="location.configuredDir && !location.custom" class="banner bad" role="status" data-testid="backup-dir-unavailable">
        <div class="grow">{{ $t('backup.dirUnavailable', [location.configuredDir]) }}</div>
      </div>
      <div v-else-if="location.sameDisk" class="banner warn" role="status" data-testid="backup-same-disk">
        <div class="grow">{{ $t('backup.sameDisk') }}</div>
      </div>

      <div v-if="schedule.loaded" class="row-item schedule" data-testid="backup-schedule">
        <label class="field">
          <span>{{ $t('backup.scheduleTitle') }}</span>
          <select v-model="schedule.hours" class="select" :disabled="!canSchedule" data-testid="backup-hours">
            <option v-for="o in HOURS_OPTIONS" :key="o.v" :value="o.v">{{ o.l }}</option>
            <option v-if="!HOURS_OPTIONS.some((o) => o.v === schedule.hours)" :value="schedule.hours">
              {{ $t('backup.scheduleHours', [schedule.hours]) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>{{ $t('backup.keepTitle') }}</span>
          <input
            v-model="schedule.keep"
            type="number"
            min="1"
            max="60"
            class="input keep"
            :disabled="!canSchedule"
            data-testid="backup-keep"
          />
        </label>
        <button
          v-if="canSchedule"
          type="button"
          class="kbtn sm"
          :disabled="savingSchedule"
          data-testid="backup-schedule-save"
          @click="saveSchedule"
        >
          {{ $t('backup.dirSave') }}
        </button>
      </div>
    </div>

    <div v-if="pending" class="banner warn" role="status" data-testid="restore-pending">
      <div class="grow">
        <b>{{ $t('backup.pendingTitle', [pending.name]) }}</b>
        <span>{{ $t('backup.pendingMsg', [fmt(pending.requestedAt)]) }}</span>
      </div>
      <button
        v-if="canImport"
        type="button"
        class="kbtn sm"
        :disabled="busy === '__cancel'"
        data-testid="restore-cancel"
        @click="cancelRestore"
      >
        {{ $t('backup.cancelRestore') }}
      </button>
    </div>
    <div
      v-if="lastResult"
      class="banner"
      :class="lastResult.ok ? 'good' : 'bad'"
      role="status"
      data-testid="restore-last"
    >
      <div class="grow">
        <b>{{ lastResult.ok ? $t('backup.lastOk', [lastResult.name]) : $t('backup.lastFail', [lastResult.name]) }}</b>
        <span>
          {{ fmt(lastResult.at) }}
          <template v-if="lastResult.previous"> · {{ $t('backup.previousSaved', [lastResult.previous]) }}</template>
          <template v-if="lastResult.rolledBack"> · {{ $t('backup.rolledBack') }}</template>
        </span>
        <span v-if="lastResult.error" class="err">{{ lastResult.error }}</span>
      </div>
    </div>

    <StateBlock v-if="loading" state="loading" compact />
    <StateBlock v-else-if="error" state="error" :message="error" compact @retry="load" />
    <StateBlock v-else-if="!backups.length" state="empty" :title="$t('backup.empty')" compact />
    <div v-else class="table-scroll">
      <table class="data-table" data-testid="backup-table">
        <thead>
          <tr>
            <th>{{ $t('backup.colName') }}</th>
            <th>{{ $t('backup.colKind') }}</th>
            <th>{{ $t('backup.colTime') }}</th>
            <th class="num">{{ $t('backup.colSize') }}</th>
            <th v-if="canImport || canExport || canDelete">
              <span class="sr-only">{{ $t('backup.colActions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in backups" :key="b.name" :class="{ on: pending?.name === b.name }">
            <td class="name" :title="b.name">{{ b.name }}</td>
            <td>
              <span class="tag">{{ KIND_LABEL[b.kind] ?? b.kind }}</span>
              <span v-if="b.inCurrentDir === false" class="tag muted" :title="location?.defaultDir">{{
                $t('backup.oldDir')
              }}</span>
            </td>
            <td class="nowrap">{{ fmt(b.createdAt) }}</td>
            <td class="num">{{ formatBytes(b.size) }}</td>
            <td v-if="canImport || canExport || canDelete" class="act">
              <button
                v-if="canExport"
                type="button"
                class="kbtn sm"
                :disabled="!!busy"
                data-testid="backup-download"
                @click="download(b)"
              >
                {{ $t('backup.download') }}
              </button>
              <template v-if="canImport">
                <span v-if="pending?.name === b.name" class="muted">{{ $t('backup.pendingShort') }}</span>
                <button
                  v-else
                  type="button"
                  class="kbtn sm"
                  :disabled="!!busy"
                  data-testid="restore-btn"
                  @click="restore(b)"
                >
                  {{ $t('backup.restore') }}
                </button>
              </template>
              <button
                v-if="canDelete && pending?.name !== b.name"
                type="button"
                class="kbtn sm danger"
                :disabled="!!busy"
                data-testid="backup-delete"
                @click="remove(b)"
              >
                {{ $t('backup.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.settings-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 20px 12px;
}
.settings-block .banner {
  margin: 0;
}
.settings-block .row-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.settings-block .grow {
  flex: 1;
  min-width: 0;
}
.settings-block .t {
  font-weight: 600;
}
.settings-block .d {
  color: var(--muted);
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dir-form {
  display: flex;
  gap: 8px;
}
.dir-form .input {
  flex: 1;
  min-width: 0;
}
.schedule {
  flex-wrap: wrap;
  align-items: flex-end;
}
.schedule .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-sm);
}
.keep {
  width: 90px;
}
.act .kbtn + .kbtn,
.act .kbtn + .muted,
.act .muted + .kbtn {
  margin-left: 6px;
}
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--fs-sm);
}
.banner .grow {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  word-break: break-all;
}
.banner span {
  color: inherit;
  opacity: 0.85;
}
.banner.warn {
  background: var(--warn-soft);
  border-color: var(--warn-line);
  color: var(--warn-text);
}
.banner.good {
  background: var(--good-soft);
  border-color: var(--good-line);
  color: var(--good);
}
.banner.bad {
  background: var(--danger-soft);
  border-color: var(--danger-line);
  color: var(--danger-text);
}
.err {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.name {
  /* 自动表格布局里 td 的 max-width 不生效：文件名列吃掉剩余宽度并省略（有 title），
     1024 宽下“恢复到此快照”按钮不再被挤到横向滚动区外 */
  width: 100%;
  max-width: 0;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.nowrap {
  white-space: nowrap;
}
.num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.act {
  text-align: right;
  white-space: nowrap;
}
tr.on td {
  background: var(--warn-soft);
}
</style>
