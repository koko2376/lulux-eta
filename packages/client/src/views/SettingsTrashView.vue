<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiPager from '../components/ui/UiPager.vue'
import { t } from '../i18n'
import { canPurge, canRestore, parseRetentionDays, trashRetentionDays } from '../lib/trash'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'

/**
 * 设置 → 回收站：客户、报价、商机、订单、任务删除后先放这里，保留天数内可恢复。
 * 恢复需要 data:write；彻底删除需要对应的 *:delete（团队服务器模式下仅 owner / admin）。
 * 保留天数（trashRetentionDays）需要 settings:write 才能修改。
 */
const PAGE_SIZE = 50

const items = ref<api.TrashItem[]>([])
const total = ref(0)
const page = ref(1)
const entity = ref<api.TrashEntity | ''>('')
const query = ref('')
const loading = ref(true)
const loadError = ref('')
const busyKey = ref('')

const retention = ref(trashRetentionDays.value)
const retentionDraft = ref<number | ''>(trashRetentionDays.value)
const savingRetention = ref(false)
const canSettings = computed(() => can('settings:write'))
const retentionInvalid = computed(() => {
  const v = retentionDraft.value
  return v === '' || !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 3650
})
const retentionDirty = computed(() => !retentionInvalid.value && Number(retentionDraft.value) !== retention.value)

const ENTITY_LABEL = computed<Record<api.TrashEntity, string>>(() => ({
  customer: t('trash.customer'),
  quote: t('trash.quote'),
  deal: t('trash.deal'),
  order: t('trash.order'),
  task: t('trash.task'),
}))

const keyOf = (item: api.TrashItem) => `${item.entity}:${item.id}`

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function dateTime(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 服务端返回的保留天数；输入框没有未保存的修改时跟着更新 */
function applyRetention(days: number): void {
  const editing = retentionDirty.value
  retention.value = days
  trashRetentionDays.value = days
  if (!editing) retentionDraft.value = days
}

let seq = 0
async function load(): Promise<void> {
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const result = await api.trashApi.list({
      entity: entity.value || undefined,
      query: query.value.trim() || undefined,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
    if (mine !== seq) return
    items.value = result.items
    total.value = result.total
    applyRetention(result.retentionDays)
    if (!result.items.length && page.value > 1 && result.total > 0) {
      page.value = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
    }
  } catch (error) {
    if (mine === seq) loadError.value = errorText(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}
onMounted(load)

watch(entity, () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
watch(page, () => void load())

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (page.value !== 1) page.value = 1
    else void load()
  }, 250)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

async function restore(item: api.TrashItem): Promise<void> {
  busyKey.value = keyOf(item)
  try {
    const result = await api.trashApi.restore(item.entity, item.id)
    toast.success(t('trash.restored', [ENTITY_LABEL.value[item.entity], item.title]))
    const dup = result.duplicates?.[0]
    if (dup) toast.info(t('trash.restoredDuplicate', [dup.company, dup.ownerName]))
    await load()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busyKey.value = ''
  }
}

async function purge(item: api.TrashItem): Promise<void> {
  const ok = await confirmDialog({
    title: t('trash.purgeTitle', [ENTITY_LABEL.value[item.entity], item.title]),
    message: t('trash.purgeMsg'),
    confirmText: t('trash.purge'),
    danger: true,
  })
  if (!ok) return
  busyKey.value = keyOf(item)
  try {
    await api.trashApi.purge(item.entity, item.id)
    toast.success(t('trash.purged'))
    await load()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busyKey.value = ''
  }
}

async function saveRetention(): Promise<void> {
  if (retentionInvalid.value) return
  savingRetention.value = true
  try {
    const settings = await api.updateSettings({ trashRetentionDays: String(Number(retentionDraft.value)) })
    const days = parseRetentionDays(settings.trashRetentionDays ?? retentionDraft.value)
    retentionDraft.value = days
    applyRetention(days)
    toast.success(t('trash.retentionSaved'))
    await load()
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    savingRetention.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('trash.title')" :sub="$t('trash.sub')" />
    <div class="doc">
      <div class="doc-inner">
        <section class="panel" data-testid="trash-retention">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('trash.retentionTitle') }}</h2>
              <div class="panel-sub">
                {{ retention > 0 ? $t('trash.retentionSub', [retention]) : $t('trash.retentionOff') }}
              </div>
            </div>
          </div>
          <div v-if="canSettings" class="panel-body">
            <form class="retention-row" novalidate @submit.prevent="saveRetention">
              <label class="field-label" for="trash-retention-days">{{ $t('trash.retentionLabel') }}</label>
              <input
                id="trash-retention-days"
                v-model.number="retentionDraft"
                class="input days"
                type="number"
                min="0"
                max="3650"
                step="1"
                :class="{ invalid: retentionInvalid }"
                data-testid="trash-retention-input"
              />
              <span class="unit">{{ $t('trash.days') }}</span>
              <button
                type="submit"
                class="kbtn primary"
                :disabled="!retentionDirty || savingRetention"
                data-testid="trash-retention-save"
              >
                {{ savingRetention ? $t('trash.saving') : $t('trash.save') }}
              </button>
            </form>
            <p class="hint">{{ $t('trash.retentionHint') }}</p>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head filters">
            <div class="segmented" role="tablist" :aria-label="$t('trash.typeLabel')">
              <button
                type="button"
                role="tab"
                :aria-selected="entity === ''"
                :class="{ on: entity === '' }"
                data-testid="trash-type-all"
                @click="entity = ''"
              >
                {{ $t('trash.all') }}
              </button>
              <button
                v-for="e in api.TRASH_ENTITIES"
                :key="e"
                type="button"
                role="tab"
                :aria-selected="entity === e"
                :class="{ on: entity === e }"
                :data-testid="`trash-type-${e}`"
                @click="entity = e"
              >
                {{ ENTITY_LABEL[e] }}
              </button>
            </div>
            <input
              v-model="query"
              class="input search"
              type="search"
              :placeholder="$t('trash.search')"
              :aria-label="$t('trash.search')"
              data-testid="trash-search"
            />
          </div>

          <StateBlock v-if="loading && !items.length" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!items.length"
            state="empty"
            :title="query || entity ? $t('trash.noMatch') : $t('trash.emptyTitle')"
            :message="query || entity ? '' : $t('trash.emptyMsg')"
            compact
          />
          <div v-else class="table-wrap" data-hscroll-ok>
            <table class="data-table" data-testid="trash-table">
              <thead>
                <tr>
                  <th>{{ $t('trash.colType') }}</th>
                  <th>{{ $t('trash.colName') }}</th>
                  <th>{{ $t('trash.colOwner') }}</th>
                  <th>{{ $t('trash.colDeletedAt') }}</th>
                  <th>{{ $t('trash.colDeletedBy') }}</th>
                  <th>{{ $t('trash.colPurgeAt') }}</th>
                  <th>
                    <span class="sr-only">{{ $t('trash.actions') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in items" :key="keyOf(item)" data-testid="trash-row">
                  <td>
                    <span class="tag">{{ ENTITY_LABEL[item.entity] }}</span>
                  </td>
                  <td>
                    <div class="strong">{{ item.title || '—' }}</div>
                    <div v-if="item.subtitle" class="sub">{{ item.subtitle }}</div>
                    <div v-if="item.cascadedTasks" class="sub">{{ $t('trash.withTasks', [item.cascadedTasks]) }}</div>
                  </td>
                  <td>{{ item.ownerName || '—' }}</td>
                  <td class="mono">{{ dateTime(item.deletedAt) }}</td>
                  <td>{{ item.deletedByName || '—' }}</td>
                  <td class="mono">{{ item.purgeAt ? dateTime(item.purgeAt) : $t('trash.never') }}</td>
                  <td class="acts">
                    <button
                      v-if="canRestore()"
                      type="button"
                      class="link"
                      :disabled="busyKey === keyOf(item)"
                      :aria-label="$t('trash.restoreOf', [item.title])"
                      data-testid="trash-restore"
                      @click="restore(item)"
                    >
                      {{ $t('trash.restore') }}
                    </button>
                    <button
                      v-if="canPurge(item.entity)"
                      type="button"
                      class="link danger"
                      :disabled="busyKey === keyOf(item)"
                      :aria-label="$t('trash.purgeOf', [item.title])"
                      data-testid="trash-purge"
                      @click="purge(item)"
                    >
                      {{ $t('trash.purge') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <UiPager v-if="total > PAGE_SIZE" v-model:page="page" :page-size="PAGE_SIZE" :total="total" />
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.retention-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.days {
  width: 96px;
}
.unit {
  color: var(--text-secondary);
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.search {
  flex: 1;
  min-width: 180px;
  max-width: 320px;
  margin-left: auto;
}
.sub {
  font-size: 12px;
  color: var(--text-tertiary);
}
.acts {
  white-space: nowrap;
  text-align: right;
}
.acts .link + .link {
  margin-left: 12px;
}
</style>
