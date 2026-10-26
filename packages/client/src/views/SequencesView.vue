<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import SequenceEditorModal from '../components/SequenceEditorModal.vue'
import { askLulux } from '../lib/ask-lulux'
import { relativeTime } from '../lib/labels'
import { can } from '../lib/session'
import { onServerEvent } from '../stores/events'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { intlLocale, t } from '../i18n'

/**
 * 开发信序列：左侧序列列表 + “待确认”+“退订名单”；右侧按所选显示：
 * - 待确认：到点生成的草稿，逐封或批量确认发送、跳过、去邮箱里改；
 * - 序列：进度统计、联系人（对方当地下一封时间 / 停发原因）、步骤；
 * - 退订名单：手动加 / 移除。
 */
const route = useRoute()
const router = useRouter()
const canWrite = computed(() => can('data:write'))
const canSend = computed(() => can('email:send'))

const sequences = ref<api.Sequence[]>([])
const accounts = ref<api.EmailAccount[]>([])
const loading = ref(true)
const loadError = ref('')
type View = { kind: 'queue' } | { kind: 'suppressions' } | { kind: 'sequence'; id: string }
const view = ref<View>({ kind: 'queue' })
const current = computed(() =>
  view.value.kind === 'sequence'
    ? (sequences.value.find((s) => s.id === (view.value as { id: string }).id) ?? null)
    : null,
)
const pendingTotal = computed(() => sequences.value.reduce((n, s) => n + s.stats.pending, 0))

const queue = ref<api.SequenceSend[]>([])
const enrollments = ref<api.SequenceEnrollment[]>([])
const suppressions = ref<Array<{ email: string; reason: string; createdAt: number }>>([])
const tab = ref<'contacts' | 'steps'>('contacts')
const busy = ref<Record<string, boolean>>({})

const editor = ref<{ sequence: api.Sequence | null } | null>(null)
const enrolling = ref(false)
const enrollText = ref('')
const enrollResult = ref<{ enrolled: number; skipped: Array<{ email: string; reason: string }> } | null>(null)
const newSuppression = ref('')

async function loadAll(): Promise<void> {
  loadError.value = ''
  try {
    const [list, accts] = await Promise.all([
      api.listSequences(),
      api.listEmailAccounts({ silent: true }).catch(() => []),
    ])
    sequences.value = list
    accounts.value = accts
    await loadView()
  } catch (e) {
    loadError.value = errorText(e)
  } finally {
    loading.value = false
  }
}

async function loadView(): Promise<void> {
  const v = view.value
  if (v.kind === 'queue') queue.value = await api.listSequenceSends({ status: 'pending', limit: 200 })
  else if (v.kind === 'suppressions') suppressions.value = await api.listSuppressions()
  else enrollments.value = await api.listSequenceEnrollments(v.id)
}

function select(next: View): void {
  view.value = next
  const query =
    next.kind === 'sequence' ? { id: next.id } : next.kind === 'suppressions' ? { view: 'suppressions' } : {}
  void router.replace({ path: '/sequences', query })
  // 切换时连同左侧统计一起刷新（回信 / 退订可能刚刚发生）
  void refresh().catch((e) => toast.error(errorText(e)))
}

watch(
  () => [route.query.id, route.query.view] as const,
  ([id, v]) => {
    const next: View =
      typeof id === 'string' && id
        ? { kind: 'sequence', id }
        : v === 'suppressions'
          ? { kind: 'suppressions' }
          : { kind: 'queue' }
    const same = JSON.stringify(next) === JSON.stringify(view.value)
    view.value = next
    // 浏览器前进 / 后退切换视图时重新取数据（首次进入由 loadAll 负责）
    if (!same && !loading.value) void refresh()
  },
  { immediate: true },
)

// 序列不存在（链接过期 / 刚被删除）：回到待确认，不留空白页
watch([current, loading, loadError], () => {
  if (view.value.kind === 'sequence' && !current.value && !loading.value && !loadError.value) select({ kind: 'queue' })
})

let reloadTimer: ReturnType<typeof setTimeout> | null = null
const stopEvents = onServerEvent('sequence.changed', () => {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void refresh(), 400)
})
async function refresh(): Promise<void> {
  sequences.value = await api.listSequences().catch(() => sequences.value)
  await loadView().catch(() => undefined)
}
onMounted(loadAll)
onBeforeUnmount(() => {
  stopEvents()
  if (reloadTimer) clearTimeout(reloadTimer)
})

/* ── 时间 ── */
const fmt = (instant: number, zone?: string) =>
  new Intl.DateTimeFormat(intlLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(zone ? { timeZone: zone } : {}),
  }).format(new Date(instant))
const city = (zone: string) => zone.split('/').pop()?.replace(/_/g, ' ') ?? zone

/* ── 待确认 ── */
async function approve(ids: string[]): Promise<void> {
  for (const id of ids) busy.value[id] = true
  try {
    const result = await api.approveSequenceSends(ids)
    if (result.sent.length) toast.success(t('seq.sentN', [result.sent.length]))
    if (result.failed.length) toast.error(t('seq.failedN', [result.failed.length, result.failed[0]!.error]))
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  } finally {
    for (const id of ids) delete busy.value[id]
  }
}
async function approveAll(): Promise<void> {
  const ids = queue.value.map((q) => q.id)
  if (!ids.length) return
  const ok = await confirmDialog({
    title: t('seq.approveAllTitle'),
    message: t('seq.approveAllMsg', [ids.length]),
    confirmText: t('seq.approveAllBtn', [ids.length]),
  })
  if (ok) await approve(ids)
}
async function skip(send: api.SequenceSend): Promise<void> {
  busy.value[send.id] = true
  try {
    await api.skipSequenceSend(send.id)
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  } finally {
    delete busy.value[send.id]
  }
}
function editDraft(send: api.SequenceSend): void {
  if (send.draftId) void router.push({ path: '/mailbox', query: { draft: send.draftId } })
}

/* ── 序列 ── */
function onSaved(saved: api.Sequence): void {
  editor.value = null
  void refresh().then(() => select({ kind: 'sequence', id: saved.id }))
}
async function toggleSequence(s: api.Sequence): Promise<void> {
  try {
    await api.updateSequence(s.id, { status: s.status === 'active' ? 'paused' : 'active' })
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  }
}
async function removeSequence(s: api.Sequence): Promise<void> {
  const ok = await confirmDialog({
    title: t('seq.deleteTitle'),
    message: t('seq.deleteMsg', [s.name]),
    confirmText: t('seq.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteSequence(s.id)
    toast.success(t('seq.deleted'))
    sequences.value = sequences.value.filter((x) => x.id !== s.id)
    select({ kind: 'queue' })
  } catch (e) {
    toast.error(errorText(e))
  }
}
async function setStatus(e: api.SequenceEnrollment, status: 'active' | 'paused' | 'stopped'): Promise<void> {
  busy.value[e.id] = true
  try {
    await api.setEnrollmentStatus(e.id, status)
    await refresh()
  } catch (err) {
    toast.error(errorText(err))
  } finally {
    delete busy.value[e.id]
  }
}

const parsed = computed(() => api.parseContactLines(enrollText.value))
async function submitEnroll(): Promise<void> {
  if (!current.value || !parsed.value.contacts.length) return
  try {
    const result = await api.enrollSequence(current.value.id, { contacts: parsed.value.contacts })
    enrollResult.value = { enrolled: result.enrolled.length, skipped: result.skipped }
    if (!result.skipped.length) {
      enrolling.value = false
      toast.success(t('seq.enrolledN', [result.enrolled.length]))
    }
    enrollText.value = ''
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  }
}
function openEnroll(): void {
  enrollText.value = ''
  enrollResult.value = null
  enrolling.value = true
}

function askWrite(): void {
  void askLulux(router, { prompt: t('seq.askPrompt') })
}

/* ── 退订名单 ── */
async function addSup(): Promise<void> {
  const email = newSuppression.value.trim()
  if (!email) return
  try {
    const r = await api.addSuppression(email)
    newSuppression.value = ''
    toast.success(r.stopped ? t('seq.supAddedStopped', [r.stopped]) : t('seq.supAdded'))
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  }
}
async function removeSup(email: string): Promise<void> {
  try {
    await api.removeSuppression(email)
    await refresh()
  } catch (e) {
    toast.error(errorText(e))
  }
}

const STATUS_LABEL = computed<Record<api.EnrollmentStatus, string>>(() => ({
  active: t('seq.stActive'),
  paused: t('seq.stPaused'),
  replied: t('seq.stReplied'),
  unsubscribed: t('seq.stUnsub'),
  bounced: t('seq.stBounced'),
  completed: t('seq.stDone'),
  stopped: t('seq.stStopped'),
}))
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('seq.title')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('seq.title') }}</h2>
      </div>
      <nav class="side-body">
        <button
          type="button"
          class="nav-row"
          :class="{ on: view.kind === 'queue' }"
          data-testid="nav-queue"
          @click="select({ kind: 'queue' })"
        >
          {{ $t('seq.queue') }}<span v-if="pendingTotal" class="count badge">{{ pendingTotal }}</span>
        </button>
        <div class="side-label">{{ $t('seq.sequences') }}</div>
        <button
          v-for="s in sequences"
          :key="s.id"
          type="button"
          class="nav-row sub"
          :class="{ on: view.kind === 'sequence' && current?.id === s.id }"
          @click="select({ kind: 'sequence', id: s.id })"
        >
          <span class="nm" :title="s.name">{{ s.name }}</span>
          <span v-if="s.status === 'paused'" class="mini">{{ $t('seq.paused') }}</span>
          <span class="count">{{ s.stats.active }}</span>
        </button>
        <button
          v-if="canWrite"
          type="button"
          class="nav-row sub add"
          :disabled="!accounts.length"
          data-testid="seq-new"
          @click="editor = { sequence: null }"
        >
          + {{ $t('seq.new') }}
        </button>
        <div class="side-label">{{ $t('seq.more') }}</div>
        <button
          type="button"
          class="nav-row sub"
          :class="{ on: view.kind === 'suppressions' }"
          @click="select({ kind: 'suppressions' })"
        >
          {{ $t('seq.suppressions') }}
        </button>
        <RouterLink class="nav-row sub" to="/mailbox">{{ $t('seq.backMailbox') }}</RouterLink>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('seq.title')" :sub="$t('seq.sub')" />
    <div class="doc">
      <StateBlock v-if="loading" state="loading" />
      <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="loadAll" />

      <!-- 没有邮箱账户 -->
      <div v-else-if="!accounts.length && !sequences.length" class="empty">
        <p class="empty-title">{{ $t('seq.noAccountTitle') }}</p>
        <p class="empty-sub">{{ $t('seq.noAccountSub') }}</p>
        <RouterLink class="btn dark" to="/settings/mailbox">{{ $t('seq.addAccount') }}</RouterLink>
      </div>

      <!-- 待确认 -->
      <template v-else-if="view.kind === 'queue'">
        <div class="head-row">
          <div>
            <h2 class="page-h">{{ $t('seq.queue') }}</h2>
            <div class="head-count">{{ $t('seq.queueSub') }}</div>
          </div>
          <div class="sp"></div>
          <button type="button" class="btn" @click="askWrite">{{ $t('seq.ask') }}</button>
          <button
            v-if="canSend && queue.length"
            type="button"
            class="btn dark"
            data-testid="approve-all"
            @click="approveAll"
          >
            {{ $t('seq.approveAllBtn', [queue.length]) }}
          </button>
        </div>
        <div v-if="!queue.length" class="empty" data-testid="queue-empty">
          <p class="empty-title">{{ sequences.length ? $t('seq.queueEmpty') : $t('seq.firstTitle') }}</p>
          <p class="empty-sub">{{ sequences.length ? $t('seq.queueEmptySub') : $t('seq.firstSub') }}</p>
          <div v-if="!sequences.length && canWrite" class="empty-actions">
            <button type="button" class="btn dark" @click="editor = { sequence: null }">{{ $t('seq.new') }}</button>
            <button type="button" class="btn" @click="askWrite">{{ $t('seq.ask') }}</button>
          </div>
        </div>
        <TransitionGroup v-else name="list" tag="div" class="cards">
          <article v-for="q in queue" :key="q.id" class="card" data-testid="queue-item">
            <div class="c-top">
              <div class="c-who">
                <b>{{ q.name || q.email }}</b>
                <span class="dim"
                  >{{ q.name ? q.email : '' }}<template v-if="q.company"> · {{ q.company }}</template></span
                >
              </div>
              <span class="chip">{{ q.sequenceName }} · {{ $t('seq.stepN', [q.stepIndex + 1]) }}</span>
            </div>
            <div class="c-subj">{{ q.subject }}</div>
            <p class="c-prev">{{ q.preview }}</p>
            <p v-if="q.missingVars.length" class="c-warn" data-testid="queue-warning">
              {{ $t('seq.missingVars', [q.missingVars.join(', ')]) }}
            </p>
            <p v-if="q.error" class="c-err">{{ q.error }}</p>
            <div class="c-acts">
              <span class="dim">{{ $t('seq.dueAt', [relativeTime(q.scheduledAt)]) }}</span>
              <span class="sp"></span>
              <button type="button" class="btn sm" :disabled="busy[q.id]" @click="skip(q)">{{ $t('seq.skip') }}</button>
              <button type="button" class="btn sm" @click="editDraft(q)">{{ $t('seq.editDraft') }}</button>
              <button
                v-if="canSend"
                type="button"
                class="btn sm dark"
                :disabled="busy[q.id]"
                data-testid="approve-one"
                @click="approve([q.id])"
              >
                {{ busy[q.id] ? $t('seq.sending') : $t('seq.approve') }}
              </button>
            </div>
          </article>
        </TransitionGroup>
      </template>

      <!-- 退订名单 -->
      <template v-else-if="view.kind === 'suppressions'">
        <div class="head-row">
          <div>
            <h2 class="page-h">{{ $t('seq.suppressions') }}</h2>
            <div class="head-count">{{ $t('seq.supSub') }}</div>
          </div>
        </div>
        <form v-if="canWrite" class="sup-add" @submit.prevent="addSup">
          <input v-model="newSuppression" type="email" class="input" :placeholder="$t('seq.supPh')" />
          <button type="submit" class="btn">{{ $t('seq.supAdd') }}</button>
        </form>
        <div v-if="!suppressions.length" class="empty">
          <p class="empty-sub">{{ $t('seq.supEmpty') }}</p>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>{{ $t('seq.email') }}</th>
              <th>{{ $t('seq.reason') }}</th>
              <th>{{ $t('seq.when') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in suppressions" :key="s.email">
              <td>{{ s.email }}</td>
              <td class="dim">{{ s.reason }}</td>
              <td class="dim">{{ relativeTime(s.createdAt) }}</td>
              <td class="r">
                <button v-if="canWrite" type="button" class="link" @click="removeSup(s.email)">
                  {{ $t('seq.supRemove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- 序列详情 -->
      <template v-else-if="current">
        <div class="head-row">
          <div class="min0">
            <h2 class="page-h ell">{{ current.name }}</h2>
            <div class="head-count">
              <span class="pill" :class="current.status">{{
                current.status === 'active' ? $t('seq.running') : $t('seq.paused')
              }}</span>
              {{ $t('seq.fromLine', [current.accountEmail, current.windowStart, current.windowEnd]) }}
              <template v-if="current.autoSend">
                · <b class="auto">{{ $t('seq.autoOn', [current.dailyLimit]) }}</b></template
              >
            </div>
          </div>
          <div class="sp"></div>
          <template v-if="canWrite">
            <button type="button" class="btn" @click="toggleSequence(current)">
              {{ current.status === 'active' ? $t('seq.pause') : $t('seq.resume') }}
            </button>
            <button type="button" class="btn" @click="editor = { sequence: current }">{{ $t('seq.edit') }}</button>
            <button type="button" class="btn ghost-danger" @click="removeSequence(current)">
              {{ $t('seq.delete') }}
            </button>
            <button type="button" class="btn dark" data-testid="seq-enroll" @click="openEnroll">
              {{ $t('seq.addContacts') }}
            </button>
          </template>
        </div>

        <div class="stats">
          <div class="stat">
            <b>{{ current.stats.total }}</b
            ><span>{{ $t('seq.sContacts') }}</span>
          </div>
          <div class="stat">
            <b>{{ current.stats.sent }}</b
            ><span>{{ $t('seq.sSent') }}</span>
          </div>
          <div class="stat">
            <b>{{ current.stats.pending }}</b
            ><span>{{ $t('seq.sPending') }}</span>
          </div>
          <div class="stat good">
            <b>{{ current.stats.replied }}</b
            ><span>{{ $t('seq.sReplied') }}</span>
          </div>
          <div class="stat">
            <b>{{ current.stats.unsubscribed + current.stats.bounced }}</b
            ><span>{{ $t('seq.sUnsub') }}</span>
          </div>
        </div>

        <div class="segmented tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :class="{ on: tab === 'contacts' }"
            :aria-selected="tab === 'contacts'"
            @click="tab = 'contacts'"
          >
            {{ $t('seq.tabContacts') }}
          </button>
          <button
            type="button"
            role="tab"
            :class="{ on: tab === 'steps' }"
            :aria-selected="tab === 'steps'"
            @click="tab = 'steps'"
          >
            {{ $t('seq.tabSteps', [current.steps.length]) }}
          </button>
        </div>

        <template v-if="tab === 'contacts'">
          <div v-if="!enrollments.length" class="empty">
            <p class="empty-title">{{ $t('seq.noContacts') }}</p>
            <p class="empty-sub">{{ $t('seq.noContactsSub') }}</p>
          </div>
          <div v-else class="table-scroll-x">
            <table class="data-table" data-testid="enrollments">
              <colgroup>
                <col />
                <col style="width: 110px" />
                <col style="width: 86px" />
                <col style="width: 190px" />
                <col style="width: 150px" />
              </colgroup>
              <thead>
                <tr>
                  <th>{{ $t('seq.contact') }}</th>
                  <th>{{ $t('seq.status') }}</th>
                  <th>{{ $t('seq.progress') }}</th>
                  <th>{{ $t('seq.next') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in enrollments" :key="e.id">
                  <td>
                    <div class="who ell" :title="e.email">
                      <b>{{ e.name || e.email }}</b>
                      <span class="dim"
                        >{{ e.name ? e.email : '' }}<template v-if="e.company"> · {{ e.company }}</template></span
                      >
                    </div>
                  </td>
                  <td>
                    <span class="st" :class="`st-${e.status}`" :title="e.stopReason">{{ STATUS_LABEL[e.status] }}</span>
                  </td>
                  <td class="dim tnum">
                    {{ Math.min(e.currentStep, current.steps.length) }}/{{ current.steps.length }}
                  </td>
                  <td class="dim">
                    <template v-if="e.nextSendAt && e.status === 'active'">
                      <div>{{ fmt(e.nextSendAt) }}</div>
                      <div class="tz">{{ $t('seq.theirTime', [city(e.timezone), fmt(e.nextSendAt, e.timezone)]) }}</div>
                    </template>
                    <span v-else-if="e.status === 'active'" class="await">{{
                      $t('seq.awaiting', [e.currentStep + 1])
                    }}</span>
                    <span v-else class="reason ell" :title="e.stopReason">{{ e.stopReason || '—' }}</span>
                  </td>
                  <td class="r">
                    <template v-if="canWrite">
                      <button
                        v-if="e.status === 'active'"
                        type="button"
                        class="link"
                        :disabled="busy[e.id]"
                        @click="setStatus(e, 'paused')"
                      >
                        {{ $t('seq.pause') }}
                      </button>
                      <button
                        v-if="e.status === 'paused'"
                        type="button"
                        class="link"
                        :disabled="busy[e.id]"
                        @click="setStatus(e, 'active')"
                      >
                        {{ $t('seq.resume') }}
                      </button>
                      <button
                        v-if="e.status === 'active' || e.status === 'paused'"
                        type="button"
                        class="link danger"
                        :disabled="busy[e.id]"
                        @click="setStatus(e, 'stopped')"
                      >
                        {{ $t('seq.stop') }}
                      </button>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else class="steps-ro">
          <div v-for="(s, i) in current.steps" :key="i" class="step-ro">
            <div class="sr-head">
              <span class="no">{{ i + 1 }}</span>
              <span class="dim">{{
                i === 0 ? $t('seq.firstWhenN', [s.delayDays]) : $t('seq.afterPrevN', [s.delayDays])
              }}</span>
            </div>
            <div class="sr-subj">{{ s.subject }}</div>
            <pre class="sr-body">{{ s.body }}</pre>
          </div>
        </div>
      </template>
    </div>
  </main>

  <SequenceEditorModal
    v-if="editor"
    :sequence="editor.sequence"
    :accounts="accounts"
    @close="editor = null"
    @saved="onSaved"
  />

  <UiModal
    v-if="enrolling && current"
    :title="$t('seq.enrollTitle')"
    :subtitle="current.name"
    :width="600"
    @close="enrolling = false"
  >
    <div class="enroll">
      <label class="field">
        <span class="field-label">{{ $t('seq.enrollLabel') }}</span>
        <textarea
          v-model="enrollText"
          class="textarea"
          rows="8"
          :placeholder="$t('seq.enrollPh')"
          data-testid="enroll-text"
        ></textarea>
      </label>
      <p class="field-hint">
        {{ $t('seq.enrollHint', [parsed.contacts.length])
        }}<template v-if="parsed.invalid.length"> {{ $t('seq.enrollInvalid', [parsed.invalid.length]) }}</template>
      </p>
      <div v-if="enrollResult" class="enroll-res" role="status">
        <p>{{ $t('seq.enrollRes', [enrollResult.enrolled, enrollResult.skipped.length]) }}</p>
        <ul>
          <li v-for="s in enrollResult.skipped" :key="s.email">
            <b>{{ s.email }}</b
            >：{{ s.reason }}
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="enrolling = false">{{ $t('seq.close') }}</button>
      <button
        type="button"
        class="btn dark"
        :disabled="!parsed.contacts.length"
        data-testid="enroll-submit"
        @click="submitEnroll"
      >
        {{ $t('seq.enrollBtn', [parsed.contacts.length]) }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
:global(:root) {
  --seq-blue: #2b62d9;
  --seq-blue-soft: #e8f0ff;
  --seq-amber: #a96512;
}
:global(:root[data-theme='dark']) {
  --seq-blue: #8fb2ff;
  --seq-blue-soft: rgba(143, 178, 255, 0.16);
  --seq-amber: #f0b467;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.page-h {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.head-count {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sp {
  flex: 1;
}
.min0 {
  min-width: 0;
}
.ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dim {
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn.sm {
  height: 30px;
  font-size: 12.5px;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.ghost-danger {
  color: var(--danger-text);
}
.nav-row .count {
  margin-left: auto;
}
.nav-row .badge {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--text);
  color: var(--on-strong);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nav-row .nm {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-row .mini {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
.nav-row.add {
  color: var(--text-secondary);
}
.empty {
  padding: 48px 20px;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: 16px;
}
.empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}
.empty-sub {
  margin: 0 auto 14px;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.empty-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  transition: box-shadow 0.2s ease;
}
.card:hover {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
}
.c-top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.c-who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.c-who b {
  font-size: 13.5px;
  font-weight: 600;
}
.chip {
  flex: none;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.c-subj {
  margin-top: 10px;
  font-size: 13.5px;
  font-weight: 500;
}
.c-prev {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.c-warn,
.c-err {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
}
.c-warn {
  color: var(--seq-amber);
  background: rgba(240, 180, 103, 0.14);
}
.c-err {
  color: var(--danger-text);
  background: var(--danger-soft);
}
.await {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.c-acts {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.list-enter-active,
.list-leave-active {
  transition: all 0.25s ease;
}
.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.pill {
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.pill.active {
  background: var(--good-soft);
  color: var(--good);
}
.auto {
  color: var(--danger-text);
  font-weight: 500;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}
.stat {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-soft);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat b {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat span {
  font-size: 12px;
  color: var(--text-secondary);
}
.stat.good b {
  color: var(--good);
}
.tabs {
  margin-bottom: 12px;
}
.who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.who b {
  font-weight: 500;
}
.st {
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.st-active {
  background: var(--good-soft);
  color: var(--good);
}
.st-replied {
  background: var(--seq-blue-soft);
  color: var(--seq-blue);
}
.st-unsubscribed,
.st-bounced {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.tz {
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.reason {
  display: block;
  max-width: 180px;
}
.r {
  text-align: right;
  white-space: nowrap;
}
.link {
  border: 0;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0 4px;
}
.link:hover {
  color: var(--text);
}
.link.danger {
  color: var(--danger-text);
}
.steps-ro {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.step-ro {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
}
.sr-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.no {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: var(--text);
  color: var(--on-strong);
}
.sr-subj {
  margin-top: 8px;
  font-weight: 500;
}
.sr-body {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.sup-add {
  display: flex;
  gap: 8px;
  max-width: 480px;
  margin-bottom: 14px;
}
.enroll {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.enroll-res {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-soft);
  font-size: 12.5px;
  line-height: 1.6;
}
.enroll-res p {
  margin: 0 0 4px;
}
.enroll-res ul {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
}
</style>
