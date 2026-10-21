<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import CustomerDeals from '../components/CustomerDeals.vue'
import CustomerFormModal from '../components/CustomerFormModal.vue'
import FollowUpModal from '../components/FollowUpModal.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { ACTIVITY_LABEL, QUOTE_STATUS_LABEL, STAGE_LABEL, formatDate, relativeTime } from '../lib/labels'
import { formatMoney } from '../lib/quote'
import {
  ROLE_LABEL,
  auth,
  can,
  canEditOwned,
  currentRole,
  currentUser,
  denyReason,
  missingPermission,
} from '../lib/session'
import { openExternal } from '../lib/window'
import logoUrl from '../assets/lulux-neutral.png'
import { askLulux } from '../lib/ask-lulux'
import { dueLabel } from '../lib/due'
import { forgetCustomer, recentCustomers, rememberCustomer } from '../lib/recent-customers'
import { intlLocale } from '../i18n'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import { trashConfirmMessage } from '../lib/trash'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

type Tab = 'overview' | 'contacts' | 'activity' | 'quotes' | 'mail'
const tab = ref<Tab>('overview')
const id = computed(() => String(route.params.id))

const customer = ref<api.Customer | null>(null)
const loading = ref(true)
const loadError = ref('')
const notFound = ref(false)

const activities = ref<api.Activity[]>([])
const actLoading = ref(true)
const actError = ref('')
const quotes = ref<api.Quote[]>([])
const quotesError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  notFound.value = false
  try {
    customer.value = await api.getCustomer(id.value)
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 404) notFound.value = true
    else loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
  if (customer.value) {
    rememberCustomer(customer.value.id, customer.value.company)
    void loadActivities()
    void loadQuotes()
    void loadTasks()
    void loadMails()
  }
}

async function loadActivities(): Promise<void> {
  actLoading.value = true
  actError.value = ''
  try {
    activities.value = await api.listActivities(id.value)
  } catch (error) {
    actError.value = errorText(error)
  } finally {
    actLoading.value = false
  }
}

async function loadQuotes(): Promise<void> {
  quotesError.value = ''
  try {
    quotes.value = (await api.listQuotesForCustomer(id.value)).filter((q) => q.customerId === id.value)
  } catch (error) {
    quotesError.value = errorText(error)
  }
}

onMounted(() => {
  void load()
  void loadStageCounts()
  if (!store.providers.length) void store.refreshProviders().catch(() => undefined)
})
watch(id, () => {
  tab.value = 'overview'
  void load()
})

async function changeStage(stage: api.Stage): Promise<void> {
  if (!customer.value || stage === customer.value.stage) return
  const before = customer.value.stage
  customer.value.stage = stage
  try {
    customer.value = await api.updateCustomer(id.value, { stage })
    toast.success(t('customerDetail.kq12ye6', [STAGE_LABEL[stage]]))
  } catch {
    if (customer.value) customer.value.stage = before
  }
}

const editing = ref(false)
function onSaved(next: api.Customer): void {
  customer.value = next
  editing.value = false
  toast.success(t('customerDetail.k1l5gy27'))
}

async function remove(): Promise<void> {
  if (!customer.value) return
  const ok = await confirmDialog({
    title: t('customerDetail.k8t1ghu', [customer.value.company]),
    message: trashConfirmMessage('customerDetail.k1y88985'),
    confirmText: t('customerDetail.k1dae1m4'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteCustomer(id.value, { silent: true })
  } catch (error) {
    // 409 CUSTOMER_HAS_RECORDS：服务端消息里列出了名下的订单 / 收款 / 报价 / 商机数量
    toast.error(errorText(error))
    return
  }
  forgetCustomer(id.value)
  toast.success(t('customerDetail.k1xqwrmq'))
  await router.replace('/customers')
}

/* ── 跟进 ── */
const draft = reactive({ type: 'note' as api.ActivityType, content: '' })
const posting = ref(false)
async function addActivity(): Promise<void> {
  if (!draft.content.trim()) return
  posting.value = true
  try {
    const act = await api.addActivity(id.value, { type: draft.type, content: draft.content.trim() })
    activities.value.unshift(act)
    draft.content = ''
  } finally {
    posting.value = false
  }
}

/* ── 负责人 / 可见性（契约 §5.6） ── */
const canEdit = computed(() => canEditOwned(customer.value?.ownerId))
const editDeny = computed(() => (can('data:write') ? t('customerDetail.k1qb6112') : denyReason('data:write')))
/** 删除客户另需 customer:delete（管理员可按账号关闭） */
const removeDeny = computed(() => {
  const missing = missingPermission(['data:write', 'customer:delete'])
  return missing ? denyReason(missing) : ''
})
const canAssign = computed(() => {
  if (auth.mode !== 'server' || !customer.value) return false
  const role = currentRole.value
  return role === 'owner' || role === 'admin' || (role === 'member' && customer.value.ownerId === currentUser.value?.id)
})
const VIS_LABEL: Record<api.Visibility, string> = {
  private: t('customerDetail.kr397bd'),
  team: t('customerDetail.kd8mn7i'),
  org: t('customerDetail.k1jpqom4'),
}
const showAssign = ref(false)
const members = ref<api.User[]>([])
const teams = ref<api.Team[]>([])
const assignForm = reactive({ ownerId: '', visibility: 'private' as api.Visibility, teamId: '' })
const assigning = ref(false)
async function openAssign(): Promise<void> {
  if (!customer.value) return
  Object.assign(assignForm, {
    ownerId: customer.value.ownerId ?? '',
    visibility: customer.value.visibility ?? 'private',
    teamId: customer.value.teamId ?? '',
  })
  showAssign.value = true
  ;[members.value, teams.value] = await Promise.all([
    api.listMembers({ silent: true }).catch(() => []),
    api.listTeams({ silent: true }).catch(() => []),
  ])
}
async function submitAssign(): Promise<void> {
  if (!customer.value || !assignForm.ownerId) return
  assigning.value = true
  try {
    customer.value = await api.assignCustomer(customer.value.id, {
      ownerId: assignForm.ownerId,
      visibility: assignForm.visibility,
      teamId: assignForm.visibility === 'team' ? assignForm.teamId || null : null,
    })
    showAssign.value = false
    toast.success(t('customerDetail.k1chlbkv', [customer.value.ownerName ?? '']))
    void loadActivities()
  } finally {
    assigning.value = false
  }
}

const websiteHost = computed(() =>
  (customer.value?.website ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, ''),
)
const websiteHref = computed(() => {
  const w = customer.value?.website?.trim()
  if (!w) return ''
  return /^https?:\/\//i.test(w) ? w : `https://${w}`
})
/* ── 跟进任务（下次跟进）── */
const tasks = ref<api.Task[]>([])
async function loadTasks(): Promise<void> {
  try {
    tasks.value = (await api.tasksApi.list({ customerId: id.value, status: 'open', limit: 50 }, true)).items
  } catch {
    tasks.value = []
  }
}
const nextTask = computed(() => tasks.value.find((x) => x.dueAt !== null) ?? tasks.value[0] ?? null)
async function taskDone(task: api.Task): Promise<void> {
  try {
    await api.tasksApi.update(task.id, { status: 'done' })
    tasks.value = tasks.value.filter((x) => x.id !== task.id)
    toast.success(t('wbx.doneOk'))
  } catch (error) {
    toast.error(errorText(error))
  }
}
const showFollow = ref(false)

/* ── 往来邮件 ── */
const mails = ref<api.EmailMessageSummary[]>([])
const mailTotal = ref(0)
const mailLoaded = ref(false)
async function loadMails(): Promise<void> {
  mailLoaded.value = false
  try {
    const res = await api.request<{ items: api.EmailMessageSummary[]; total: number }>('/api/email/messages', {
      query: { customerId: id.value, folder: 'all', pageSize: 50 },
      silent: true,
    })
    mails.value = res.items ?? []
    mailTotal.value = res.total ?? mails.value.length
  } catch {
    mails.value = []
    mailTotal.value = 0
  } finally {
    mailLoaded.value = true
  }
}
const VERDICT_KEY: Record<string, string> = {
  inquiry: 'custdx.vInquiry',
  review: 'custdx.vReview',
  spam: 'custdx.vSpam',
}

/* ── 侧栏：按阶段计数 ── */
const stageCounts = ref<Partial<Record<api.Stage, number>>>({})
async function loadStageCounts(): Promise<void> {
  try {
    stageCounts.value = (await api.getWorkbenchSummary()).customers.byStage
  } catch {
    stageCounts.value = {}
  }
}
const sideQ = ref('')
function sideSearch(): void {
  const q = sideQ.value.trim()
  void router.push(q ? { path: '/customers', query: { q } } : '/customers')
}

/* ── 页头 ── */
const primaryContact = computed(() => customer.value?.contacts.find((c) => c.isPrimary) ?? customer.value?.contacts[0])
const mailTo = computed(() => primaryContact.value?.email || '')
function writeMail(): void {
  if (!customer.value) return
  void router.push({
    path: '/mailbox',
    query: { compose: '1', to: mailTo.value || undefined, customer: customer.value.id },
  })
}

/* ── LULUX 客户摘要（确定性：按真实数据拼句子） ── */
function boldParts(text: string): Array<{ b: boolean; s: string }> {
  return text.split('**').map((s, i) => ({ b: i % 2 === 1, s }))
}
const lastActivity = computed(() => activities.value[0] ?? null)
const lastInbound = computed(() => mails.value.find((m) => m.folder === 'inbox') ?? null)
const openQuotes = computed(() => quotes.value.filter((q) => q.status === 'draft' || q.status === 'sent'))
const aiText = computed(() => {
  const c = customer.value
  if (!c) return ''
  const parts: string[] = [t('custdx.aiStage', [c.company, STAGE_LABEL[c.stage]])]
  if (lastInbound.value) {
    parts.push(
      t('custdx.aiLastMail', [
        relativeTime(lastInbound.value.date),
        lastInbound.value.subject || t('shellx.noSubject'),
      ]),
    )
  }
  if (lastActivity.value) parts.push(t('custdx.aiLastAct', [relativeTime(lastActivity.value.createdAt)]))
  else parts.push(t('custdx.aiNoAct'))
  if (openQuotes.value.length) parts.push(t('custdx.aiQuotes', [openQuotes.value.length]))
  const nt = nextTask.value
  if (nt) {
    const due = dueLabel(nt.dueAt)
    parts.push(
      due.cls === 'over' ? t('custdx.aiTaskOver', [nt.title, due.text]) : t('custdx.aiTask', [nt.title, due.text]),
    )
  } else if (c.stage !== 'won' && c.stage !== 'lost') {
    parts.push(t('custdx.aiNoTask'))
  }
  return parts.join('')
})
const aiTime = computed(() =>
  lastActivity.value ? relativeTime(lastActivity.value.createdAt) : formatDate(customer.value?.createdAt),
)
const canSummarize = computed(() => store.providers.length > 0)
function askAbout(): void {
  if (!customer.value) return
  void askLulux(router, {
    customerId: customer.value.id,
    prompt: t('custdx.aiPrompt', [customer.value.company]),
  })
}
function draftReply(): void {
  if (lastInbound.value) void router.push({ path: '/mailbox', query: { message: lastInbound.value.id } })
  else writeMail()
}
const fmtTime = (v: number | string) =>
  new Date(v).toLocaleString(intlLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <aside class="side" :aria-label="$t('customers.k1v5iwp2')">
    <div class="side-head">
      <h2 class="side-title">{{ $t('customers.k1v5iwp2') }}</h2>
      <RouterLink v-perm:hide="'data:write'" class="link" to="/customers?new=1">{{
        $t('customers.k3ke49o')
      }}</RouterLink>
    </div>
    <form class="side-search" role="search" @submit.prevent="sideSearch">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <input
        v-model="sideQ"
        type="search"
        :placeholder="$t('customers.kf31amz')"
        :aria-label="$t('wbx.sideSearchAria')"
        spellcheck="false"
      />
    </form>
    <nav class="side-body">
      <template v-if="recentCustomers.length">
        <div class="side-label first">{{ $t('wbx.recentViewed') }}</div>
        <RouterLink
          v-for="c in recentCustomers.slice(0, 6)"
          :key="c.id"
          class="nav-row"
          :class="{ on: c.id === id }"
          :to="`/customers/${c.id}`"
          :aria-current="c.id === id ? 'page' : undefined"
        >
          <InitialBadge :name="c.company" :size="28" />
          <span class="nav-ellipsis">{{ c.company }}</span>
        </RouterLink>
      </template>
      <div class="side-label">{{ $t('custdx.byStage') }}</div>
      <RouterLink v-for="s in api.STAGES" :key="s" class="nav-row sub" :to="{ path: '/customers', query: { stage: s } }"
        >{{ STAGE_LABEL[s] }}<span class="count">{{ stageCounts[s] ?? 0 }}</span></RouterLink
      >
      <template v-if="customer">
        <div class="side-label">{{ $t('custdx.quick') }}</div>
        <button type="button" class="nav-row" @click="writeMail">{{ $t('custdx.writeMail') }}</button>
        <RouterLink class="nav-row" :to="{ path: '/quotation/new', query: { customer: customer.id } }">{{
          $t('customerDetail.k1nvrgqa')
        }}</RouterLink>
        <button type="button" class="nav-row" @click="showFollow = true">{{ $t('custdx.addFollow') }}</button>
      </template>
    </nav>
  </aside>

  <main class="main">
    <PageTopbar
      :title="customer?.company || $t('customerDetail.k1kttfl1')"
      :crumbs="[{ label: $t('customers.k1v5iwp2'), to: '/customers' }]"
      :ask-customer="customer?.id"
    />

    <div class="doc">
      <StateBlock v-if="loading" state="loading" />
      <StateBlock
        v-else-if="notFound"
        state="empty"
        :title="$t('customerDetail.kjph5om')"
        :message="$t('customerDetail.k1nlbcsk')"
      >
        <RouterLink class="kbtn" to="/customers">{{ $t('customerDetail.kf87lgq') }}</RouterLink>
      </StateBlock>
      <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />

      <template v-else-if="customer">
        <!-- 页头 -->
        <div class="profile">
          <InitialBadge :name="customer.company" :size="54" square class="p-ava" />
          <div class="p-main">
            <div class="p-name">
              <h2>{{ customer.company }}</h2>
              <span class="stage-pill" :class="`s-${customer.stage}`">{{ STAGE_LABEL[customer.stage] }}</span>
            </div>
            <div class="p-meta">
              <span>{{ customer.country || $t('customerDetail.kkrhb5z') }}</span>
              <template v-if="websiteHref">
                <i></i>
                <button type="button" class="link ext" @click="openExternal(websiteHref)">{{ websiteHost }} ↗</button>
              </template>
              <template v-if="customer.ownerName">
                <i></i><span>{{ $t('custdx.ownerIs', [customer.ownerName]) }}</span>
              </template>
              <template v-if="customer.source">
                <i></i><span>{{ $t('custdx.sourceIs', [customer.source]) }}</span>
              </template>
            </div>
          </div>
          <div class="p-actions">
            <button type="button" class="btn" @click="writeMail">{{ $t('custdx.writeMail') }}</button>
            <RouterLink class="btn" :to="{ path: '/quotation/new', query: { customer: customer.id } }">{{
              $t('customerDetail.k1nvrgqa')
            }}</RouterLink>
            <button
              type="button"
              class="btn"
              :disabled="!canEdit"
              :title="canEdit ? '' : editDeny"
              @click="editing = true"
            >
              {{ $t('customerDetail.k1alsnuo') }}
            </button>
            <button
              type="button"
              class="btn danger"
              :disabled="!canEdit || !!removeDeny"
              :title="removeDeny || (canEdit ? '' : editDeny)"
              data-testid="customer-delete"
              @click="remove"
            >
              {{ $t('customerDetail.kfcqesv') }}
            </button>
          </div>
        </div>

        <!-- 标签页 -->
        <div class="tabs" role="tablist">
          <button
            v-for="tb in [
              { k: 'overview', label: $t('custdx.tOverview'), n: null },
              { k: 'contacts', label: $t('customerDetail.ka12e6j'), n: customer.contacts.length },
              { k: 'activity', label: $t('custdx.tActivity'), n: activities.length },
              { k: 'quotes', label: $t('custdx.tQuotes'), n: quotes.length },
              { k: 'mail', label: $t('custdx.tMail'), n: mailLoaded ? mailTotal : null },
            ] as const"
            :key="tb.k"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: tab === tb.k }"
            :aria-selected="tab === tb.k"
            @click="tab = tb.k"
          >
            {{ tb.label }}<span v-if="tb.n !== null" class="n">{{ tb.n }}</span>
          </button>
        </div>

        <!-- 概览 -->
        <div v-if="tab === 'overview'" class="detail-cols">
          <div class="col">
            <section class="ai-card" data-testid="customer-ai">
              <div class="ai-head">
                <img :src="logoUrl" alt="" />
                <b>{{ $t('custdx.aiTitle') }}</b>
                <span class="when">{{ aiTime }}</span>
              </div>
              <p>
                <template v-for="(p, i) in boldParts(aiText)" :key="i"
                  ><b v-if="p.b">{{ p.s }}</b
                  ><template v-else>{{ p.s }}</template></template
                >
              </p>
              <div class="ai-actions">
                <button type="button" @click="draftReply">{{ $t('custdx.aiReply') }}</button>
                <RouterLink :to="{ path: '/quotation/new', query: { customer: customer.id } }">{{
                  $t('wbx.aiQuote')
                }}</RouterLink>
                <button type="button" @click="showFollow = true">{{ $t('wbx.aiFollow') }}</button>
                <button v-if="canSummarize" type="button" @click="askAbout">{{ $t('custdx.aiAsk') }}</button>
              </div>
            </section>

            <section class="card">
              <div class="sec-head">
                <h3 class="sec-title">{{ $t('customerDetail.ka12e6j') }}</h3>
                <button v-if="canEdit" type="button" class="link" @click="editing = true">
                  {{ $t('custdx.add') }}
                </button>
              </div>
              <p v-if="!customer.contacts.length" class="empty-line">{{ $t('customerDetail.kac9s2d') }}</p>
              <div v-else class="contacts">
                <div v-for="ct in customer.contacts.slice(0, 4)" :key="ct.id" class="person">
                  <InitialBadge :name="ct.name || ct.email || '?'" :size="34" />
                  <div class="person-main">
                    <div class="person-name">{{ ct.name || $t('customerDetail.kuut15n') }}</div>
                    <div class="person-role">
                      {{ [ct.title, ct.isPrimary ? $t('custdx.primary') : ''].filter(Boolean).join(' · ') || '—' }}
                    </div>
                    <div v-if="ct.email" class="person-mail sel">{{ ct.email }}</div>
                  </div>
                </div>
              </div>
            </section>

            <section class="card">
              <div class="sec-head">
                <h3 class="sec-title">{{ $t('customerDetail.klhkzqt') }}</h3>
                <button v-if="activities.length > 5" type="button" class="link" @click="tab = 'activity'">
                  {{ $t('custdx.allN', [activities.length]) }}
                </button>
              </div>
              <form class="composer" @submit.prevent="addActivity">
                <select v-model="draft.type" class="select sm type" :aria-label="$t('customerDetail.k129s5c4')">
                  <option v-for="(label, key) in ACTIVITY_LABEL" :key="key" :value="key">{{ label }}</option>
                </select>
                <input
                  v-model="draft.content"
                  class="input"
                  :placeholder="$t('customerDetail.k63zrde')"
                  :aria-label="$t('customerDetail.k1bhkdch')"
                  maxlength="2000"
                />
                <button
                  v-perm="'data:write'"
                  type="submit"
                  class="kbtn primary"
                  :disabled="posting || !draft.content.trim()"
                >
                  {{ $t('customerDetail.k153b6jm') }}
                </button>
              </form>
              <StateBlock v-if="actLoading" state="loading" compact />
              <StateBlock v-else-if="actError" state="error" :message="actError" compact @retry="loadActivities" />
              <p v-else-if="!activities.length" class="empty-line">{{ $t('customerDetail.k190amr1') }}</p>
              <div v-else class="timeline">
                <div v-for="(a, i) in activities.slice(0, 5)" :key="a.id" class="tl">
                  <span class="tl-dot" :class="{ good: i === 0 }"></span>
                  <div class="tl-when">
                    {{ fmtTime(a.createdAt) }} · {{ ACTIVITY_LABEL[a.type] ?? a.type
                    }}<template v-if="auth.mode === 'server' && a.actorName"> · {{ a.actorName }}</template>
                  </div>
                  <div class="tl-body pre">{{ a.content }}</div>
                </div>
              </div>
            </section>

            <CustomerDeals :customer-id="customer.id" :customer-name="customer.company" :can-edit="canEdit" />
          </div>

          <div class="col">
            <section class="card">
              <div class="sec-head">
                <h3 class="sec-title">{{ $t('custdx.info') }}</h3>
                <button v-if="canEdit" type="button" class="link" @click="editing = true">
                  {{ $t('customerDetail.k1alsnuo') }}
                </button>
              </div>
              <div class="info">
                <div class="irow">
                  <span class="k">{{ $t('custx.country') }}</span
                  ><span class="v">{{ customer.country || '—' }}</span>
                </div>
                <div class="irow">
                  <span class="k">{{ $t('customerDetail.kl9iz6y') }}</span>
                  <select
                    class="select sm stage-sel"
                    :disabled="!canEdit"
                    :value="customer.stage"
                    :aria-label="$t('customerDetail.kl9iz6y')"
                    @change="changeStage(($event.target as HTMLSelectElement).value as api.Stage)"
                  >
                    <option v-for="s in api.STAGES" :key="s" :value="s">{{ STAGE_LABEL[s] }}</option>
                  </select>
                </div>
                <div class="irow">
                  <span class="k">{{ $t('customerDetail.k1j08rmu') }}</span
                  ><span class="v">{{ customer.source || '—' }}</span>
                </div>
                <div class="irow" data-testid="customer-owner">
                  <span class="k">{{ $t('customerDetail.k15zb5mn') }}</span>
                  <span class="v hstack">
                    {{ customer.ownerName || '—' }}
                    <span v-if="auth.mode === 'server'" class="tag">{{
                      VIS_LABEL[customer.visibility ?? 'private']
                    }}</span>
                    <button v-if="canAssign" type="button" class="link" @click="openAssign">
                      {{ $t('customerDetail.k15sr8q4') }}
                    </button>
                  </span>
                </div>
                <div class="irow">
                  <span class="k">{{ $t('custx.nextFollow') }}</span>
                  <span v-if="nextTask" class="v" :class="dueLabel(nextTask.dueAt).cls">{{
                    dueLabel(nextTask.dueAt).text
                  }}</span>
                  <button v-else type="button" class="link" @click="showFollow = true">
                    {{ $t('wbx.aiFollow') }}
                  </button>
                </div>
                <div class="irow">
                  <span class="k">{{ $t('custdx.created') }}</span
                  ><span class="v">{{ formatDate(customer.createdAt) }}</span>
                </div>
                <div v-if="customer.notes" class="irow">
                  <span class="k">{{ $t('customerDetail.k1q7l0g0') }}</span
                  ><span class="v pre">{{ customer.notes }}</span>
                </div>
              </div>
              <div v-if="customer.tags.length" class="info-tags">
                <RouterLink
                  v-for="it in customer.tags"
                  :key="it"
                  class="tag"
                  :to="{ path: '/customers', query: { tag: it } }"
                  >{{ it }}</RouterLink
                >
              </div>
            </section>

            <section class="card">
              <div class="sec-head">
                <h3 class="sec-title">{{ $t('custdx.recentQuotes') }}</h3>
                <button v-if="quotes.length > 3" type="button" class="link" @click="tab = 'quotes'">
                  {{ $t('custdx.allQuotes', [quotes.length]) }}
                </button>
              </div>
              <StateBlock v-if="quotesError" state="error" :message="quotesError" compact @retry="loadQuotes" />
              <div v-else-if="!quotes.length" class="empty-line">
                {{ $t('customerDetail.k1rif8gv') }}
                <RouterLink class="link" :to="{ path: '/quotation/new', query: { customer: customer.id } }">{{
                  $t('customerDetail.k1nvrgqa')
                }}</RouterLink>
              </div>
              <div v-else class="qlist">
                <RouterLink v-for="q in quotes.slice(0, 3)" :key="q.id" class="qrow" :to="`/quotation/${q.id}`">
                  <div>
                    <div class="qn">{{ q.number }}</div>
                    <div class="qd">{{ formatDate(q.updatedAt) }} · {{ $t('custdx.skuN', [q.items.length]) }}</div>
                  </div>
                  <div class="qr">
                    <div class="qv">{{ formatMoney(q.subtotal, q.currency) }}</div>
                    <span class="tag">{{ QUOTE_STATUS_LABEL[q.status] }}</span>
                  </div>
                </RouterLink>
              </div>
            </section>
          </div>
        </div>

        <!-- 联系人 -->
        <section v-else-if="tab === 'contacts'" class="card tab-card">
          <div class="sec-head">
            <h3 class="sec-title">{{ $t('customerDetail.ka12e6j') }}</h3>
            <button v-if="canEdit" type="button" class="link" @click="editing = true">
              {{ $t('customerDetail.k1alsnuo') }}
            </button>
          </div>
          <p v-if="!customer.contacts.length" class="empty-line">{{ $t('customerDetail.kac9s2d') }}</p>
          <div v-else class="contacts wide">
            <div v-for="ct in customer.contacts" :key="ct.id" class="person">
              <InitialBadge :name="ct.name || ct.email || '?'" :size="34" />
              <div class="person-main">
                <div class="person-name">
                  {{ ct.name || $t('customerDetail.kuut15n') }}
                  <span v-if="ct.isPrimary" class="tag good">{{ $t('customerDetail.k1y2t6cm') }}</span>
                </div>
                <div v-if="ct.title" class="person-role">{{ ct.title }}</div>
                <div v-if="ct.email" class="person-mail sel">{{ ct.email }}</div>
                <div v-if="ct.phone" class="person-role">{{ $t('customerDetail.k1cqoom4', [ct.phone]) }}</div>
                <div v-if="ct.whatsapp" class="person-role">WhatsApp {{ ct.whatsapp }}</div>
              </div>
            </div>
          </div>
        </section>

        <!-- 跟进 -->
        <div v-else-if="tab === 'activity'" class="detail-cols">
          <section class="card">
            <div class="sec-head">
              <h3 class="sec-title">{{ $t('customerDetail.klhkzqt') }}</h3>
            </div>
            <form class="composer" @submit.prevent="addActivity">
              <select v-model="draft.type" class="select sm type" :aria-label="$t('customerDetail.k129s5c4')">
                <option v-for="(label, key) in ACTIVITY_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
              <input
                v-model="draft.content"
                class="input"
                :placeholder="$t('customerDetail.k63zrde')"
                :aria-label="$t('customerDetail.k1bhkdch')"
                maxlength="2000"
              />
              <button
                v-perm="'data:write'"
                type="submit"
                class="kbtn primary"
                :disabled="posting || !draft.content.trim()"
              >
                {{ $t('customerDetail.k153b6jm') }}
              </button>
            </form>
            <p v-if="!activities.length" class="empty-line">{{ $t('customerDetail.k190amr1') }}</p>
            <div v-else class="timeline">
              <div v-for="(a, i) in activities" :key="a.id" class="tl">
                <span class="tl-dot" :class="{ good: i === 0 }"></span>
                <div class="tl-when">
                  {{ fmtTime(a.createdAt) }} · {{ ACTIVITY_LABEL[a.type] ?? a.type
                  }}<template v-if="auth.mode === 'server' && a.actorName"> · {{ a.actorName }}</template>
                </div>
                <div class="tl-body pre">{{ a.content }}</div>
              </div>
            </div>
          </section>
          <section class="card">
            <div class="sec-head">
              <h3 class="sec-title">{{ $t('custdx.openTasks') }}</h3>
              <button type="button" class="link" @click="showFollow = true">{{ $t('wbx.aiFollow') }}</button>
            </div>
            <p v-if="!tasks.length" class="empty-line">{{ $t('wbx.todoEmpty') }}</p>
            <div v-else class="qlist">
              <div v-for="task in tasks" :key="task.id" class="qrow">
                <div class="grow">
                  <div class="qn">{{ task.title }}</div>
                  <div class="qd" :class="dueLabel(task.dueAt).cls">{{ dueLabel(task.dueAt).text }}</div>
                </div>
                <button type="button" class="kbtn sm" @click="taskDone(task)">{{ $t('wbx.markDone') }}</button>
              </div>
            </div>
          </section>
        </div>

        <!-- 报价 -->
        <section v-else-if="tab === 'quotes'" class="card tab-card">
          <div class="sec-head">
            <h3 class="sec-title">{{ $t('customerDetail.k1py8dnr') }}</h3>
            <RouterLink class="link" :to="{ path: '/quotation/new', query: { customer: customer.id } }">{{
              $t('customerDetail.k1nvrgqa')
            }}</RouterLink>
          </div>
          <StateBlock v-if="quotesError" state="error" :message="quotesError" compact @retry="loadQuotes" />
          <p v-else-if="!quotes.length" class="empty-line">{{ $t('customerDetail.k1rif8gv') }}</p>
          <div v-else class="qlist">
            <RouterLink v-for="q in quotes" :key="q.id" class="qrow" :to="`/quotation/${q.id}`">
              <div>
                <div class="qn">{{ q.number }}</div>
                <div class="qd">
                  {{ q.incoterm }} {{ q.port }} · {{ formatDate(q.updatedAt) }} ·
                  {{ $t('custdx.skuN', [q.items.length]) }}
                </div>
              </div>
              <div class="qr">
                <div class="qv">{{ formatMoney(q.subtotal, q.currency) }}</div>
                <span class="tag">{{ QUOTE_STATUS_LABEL[q.status] }}</span>
              </div>
            </RouterLink>
          </div>
        </section>

        <!-- 邮件 -->
        <section v-else class="card tab-card">
          <div class="sec-head">
            <h3 class="sec-title">{{ $t('custdx.tMail') }}</h3>
            <button type="button" class="link" @click="writeMail">{{ $t('custdx.writeMail') }}</button>
          </div>
          <StateBlock v-if="!mailLoaded" state="loading" compact />
          <p v-else-if="!mails.length" class="empty-line">{{ $t('custdx.noMail') }}</p>
          <div v-else class="qlist">
            <RouterLink
              v-for="m in mails"
              :key="m.id"
              class="qrow"
              :to="{ path: '/mailbox', query: { message: m.id } }"
            >
              <div class="grow">
                <div class="qn" :class="{ unread: !m.seen }">{{ m.subject || $t('shellx.noSubject') }}</div>
                <div class="qd">
                  {{ m.folder === 'sent' ? $t('custdx.mailSent') : m.from?.name || m.from?.address }} ·
                  {{ fmtTime(m.date) }}
                </div>
              </div>
              <span v-if="m.verdict && VERDICT_KEY[m.verdict]" class="tag" :class="{ good: m.verdict === 'inquiry' }">{{
                $t(VERDICT_KEY[m.verdict])
              }}</span>
            </RouterLink>
          </div>
        </section>
      </template>
    </div>

    <CustomerFormModal v-if="editing && customer" :customer="customer" @close="editing = false" @saved="onSaved" />
    <FollowUpModal
      v-if="showFollow && customer"
      :customer-id="customer.id"
      :customer-name="customer.company"
      @close="showFollow = false"
      @created="loadTasks"
    />
    <UiModal
      v-if="showAssign"
      :title="$t('customerDetail.k1roa56a')"
      :subtitle="$t('customerDetail.k1b7uiu')"
      :width="440"
      @close="showAssign = false"
    >
      <form id="assign-form" class="stack" @submit.prevent="submitAssign">
        <label class="field">
          <span class="field-label">{{ $t('customerDetail.k15zb5mn') }}</span>
          <select v-model="assignForm.ownerId" class="select" name="owner">
            <option v-for="m in members.filter((x) => !x.disabled)" :key="m.id" :value="m.id">
              {{ $t('fmt.paren', [m.name, ROLE_LABEL[m.role]]) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('customerDetail.kr2943m') }}</span>
          <select v-model="assignForm.visibility" class="select" name="visibility">
            <option value="private">{{ $t('customerDetail.k1fc1kpw') }}</option>
            <option value="team">{{ $t('customerDetail.kd8mn7i') }}</option>
            <option value="org">{{ $t('customerDetail.k1jpqom4') }}</option>
          </select>
        </label>
        <label v-if="assignForm.visibility === 'team'" class="field">
          <span class="field-label">{{ $t('customerDetail.k9e0mjz') }}</span>
          <select v-model="assignForm.teamId" class="select">
            <option value="" disabled>{{ $t('customerDetail.kf1dt01') }}</option>
            <option v-for="it in teams" :key="it.id" :value="it.id">{{ it.name }}</option>
          </select>
        </label>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showAssign = false">{{ $t('customerDetail.kldkknc') }}</button>
        <button type="submit" form="assign-form" class="kbtn primary" :disabled="assigning || !assignForm.ownerId">
          {{ $t('customerDetail.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.nav-ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-label.first {
  padding-top: 8px;
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
.nav-row .count {
  margin-left: auto;
}

/* 页头 */
.profile {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 4px 0 20px;
}
.p-ava {
  border-radius: 14px !important;
  font-size: 17px !important;
  background: var(--surface) !important;
  box-shadow: inset 0 0 0 1px var(--line-strong) !important;
}
.p-main {
  flex: 1;
  min-width: 0;
}
.p-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.p-name h2 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-meta {
  display: flex;
  align-items: center;
  gap: 10px 14px;
  margin-top: 7px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  flex-wrap: wrap;
}
.p-meta i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--switch-off);
}
.p-meta .link {
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.p-meta .link:hover {
  color: var(--text);
}
.p-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.btn.danger {
  color: var(--danger-text);
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 标签页 */
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 20px;
}
.tab {
  height: 40px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13.5px;
  color: var(--text-secondary);
  position: relative;
}
.tab:hover {
  color: var(--text);
}
.tab .n {
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.tab.on {
  color: var(--text);
  font-weight: 600;
}
.tab.on::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  background: var(--text);
  border-radius: 2px 2px 0 0;
}

.detail-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 316px;
  gap: 14px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.col :deep(.panel) {
  margin-bottom: 0;
}
.tab-card {
  max-width: 960px;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 4px;
}
.sec-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.empty-line {
  margin: 0;
  padding: 8px 20px 18px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.contacts {
  padding: 8px 20px 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.contacts.wide {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.person {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.person-main {
  min-width: 0;
}
.person-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
.person-role {
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 1px;
}
.person-mail {
  font-size: 11.5px;
  color: var(--text-secondary);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel {
  user-select: text;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 10px 20px 6px;
}
.composer .type {
  width: 96px;
  flex: none;
}
.composer .input {
  flex: 1;
  min-width: 0;
}

.timeline {
  padding: 12px 20px 20px;
}
.tl {
  position: relative;
  padding-left: 22px;
  padding-bottom: 18px;
}
.tl:last-child {
  padding-bottom: 2px;
}
.tl::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 5px;
  bottom: 0;
  width: 1px;
  background: var(--line);
}
.tl:last-child::before {
  display: none;
}
.tl-dot {
  position: absolute;
  left: 0;
  top: 3px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: inset 0 0 0 2px var(--switch-off);
}
.tl-dot.good {
  background: var(--good);
  box-shadow: none;
}
.tl-when {
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.tl-body {
  font-size: 13px;
  color: var(--text);
  margin-top: 3px;
  line-height: 1.65;
}
.pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.info {
  padding: 12px 20px 18px;
}
.irow {
  display: flex;
  align-items: baseline;
  min-height: 34px;
  padding: 8px 0;
  font-size: 12.5px;
  border-top: 1px solid var(--surface-muted);
}
.irow:first-child {
  border-top: 0;
}
.irow .k {
  width: 76px;
  flex: none;
  color: var(--text-tertiary);
}
.irow .v {
  color: var(--text-secondary);
  min-width: 0;
}
.irow .v.over {
  color: var(--danger-text);
  font-weight: 500;
}
.irow .v.today {
  color: var(--text);
  font-weight: 500;
}
.stage-sel {
  width: auto;
  min-width: 110px;
}
.info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 20px 18px;
}

.qlist {
  padding: 4px 20px 10px;
}
.qrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-top: 1px solid var(--surface-muted);
  color: inherit;
}
.qrow:first-child {
  border-top: 0;
}
a.qrow:hover .qn {
  text-decoration: underline;
}
.grow {
  flex: 1;
  min-width: 0;
}
.qn {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qn.unread::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text);
  vertical-align: middle;
}
.qd {
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.qd.over {
  color: var(--danger-text);
}
.qd.today {
  color: var(--text);
}
.qr {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.qv {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1180px) {
  .detail-cols {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
