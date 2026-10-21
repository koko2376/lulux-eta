<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api'
import CustomerPicker from '../components/CustomerPicker.vue'
import CustomerDuplicateNotice from '../components/CustomerDuplicateNotice.vue'
import MailDraftEditor from '../components/MailDraftEditor.vue'
import logoUrl from '../assets/lulux-neutral.png'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import { downloadBlob, formatBytes } from '../lib/download'
import { relativeTime } from '../lib/labels'
import {
  VERDICT_LABEL,
  VERDICT_SOURCE_LABEL,
  emailErrorText,
  formatAddress,
  formatAddressList,
  mailTime,
} from '../lib/mail'
import { can, denyReason } from '../lib/session'
import { onServerEvent } from '../stores/events'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { intlLocale, t } from '../i18n'

const route = useRoute()
const router = useRouter()

/* ── 账户 ── */
const accounts = ref<api.EmailAccount[]>([])
const accountsLoading = ref(true)
const accountsError = ref('')
const accountId = ref<string>(typeof route.query.account === 'string' ? route.query.account : '')
const currentAccount = computed(() => accounts.value.find((a) => a.id === accountId.value) ?? null)
/** 自己的邮箱在组织开启“管理员可查看成员邮箱”时显示提示 */
const adminNotice = computed(() =>
  (currentAccount.value ? [currentAccount.value] : accounts.value).some((a) => a.adminCanRead && a.contentAccess === 'own'),
)
/** 管理员正在查看别人的邮箱（会记审计） */
const readingAsAdmin = computed(() => currentAccount.value?.contentAccess === 'admin')
/** 管理员选中了不能查看内容的成员邮箱 */
const restrictedSelected = computed(() => currentAccount.value?.contentAccess === 'restricted')
const syncing = computed(() =>
  (currentAccount.value ? [currentAccount.value] : accounts.value).some((a) => a.status.state === 'syncing'),
)
const lastSyncAt = computed(() => {
  const list = currentAccount.value ? [currentAccount.value] : accounts.value
  const times = list.map((a) => a.status.lastSyncAt ?? 0).filter(Boolean)
  return times.length ? Math.max(...times) : null
})
const accountProblem = computed(() =>
  (currentAccount.value ? [currentAccount.value] : accounts.value).find(
    (a) => a.status.state === 'error' || a.status.state === 'needs_reauth' || a.secretError,
  ),
)

async function loadAccounts(): Promise<void> {
  accountsLoading.value = true
  accountsError.value = ''
  try {
    accounts.value = await api.listEmailAccounts()
    if (accountId.value && !accounts.value.some((a) => a.id === accountId.value)) accountId.value = ''
  } catch (error) {
    accountsError.value = errorText(error)
  } finally {
    accountsLoading.value = false
  }
}

/* ── 列表 ── */
type Folder = 'inbox' | 'sent' | 'drafts'
const folder = ref<Folder>((route.query.folder as Folder) || 'inbox')
/* 工作台 / 客户页 / 全局搜索的链接：?verdict=inquiry|review|spam|none、?q=关键字、?message=<id>、?compose=1&to=&customer= */
const qstr = (v: unknown): string => (typeof v === 'string' ? v : '')
const VERDICT_PARAMS = ['inquiry', 'review', 'spam', 'none'] as const
const verdictParam = (v: unknown): '' | api.Verdict | 'none' =>
  (VERDICT_PARAMS as readonly string[]).includes(qstr(v)) ? (qstr(v) as api.Verdict | 'none') : ''
const verdict = ref<'' | api.Verdict | 'none'>(verdictParam(route.query.verdict))
const query = ref(qstr(route.query.q))
const unreadOnly = ref(false)
const PAGE = 50
const page = ref(1)
const messages = ref<api.EmailMessageSummary[]>([])
const total = ref(0)
const listLoading = ref(false)
const listError = ref('')
const drafts = ref<api.EmailDraft[]>([])

async function loadList(reset = true): Promise<void> {
  if (!accounts.value.length) return
  if (reset) page.value = 1
  if (restrictedSelected.value) {
    messages.value = []
    drafts.value = []
    total.value = 0
    selectedId.value = null
    message.value = null
    return
  }
  listLoading.value = true
  listError.value = ''
  try {
    if (folder.value === 'drafts') {
      drafts.value = (await api.listEmailDrafts({ accountId: accountId.value || undefined })).filter(
        (d) => d.status !== 'sent',
      )
    } else {
      const res = await api.listEmailMessages({
        accountId: accountId.value || undefined,
        folder: folder.value,
        verdict: folder.value === 'inbox' ? verdict.value || undefined : undefined,
        query: query.value.trim() || undefined,
        unread: unreadOnly.value ? 1 : undefined,
        page: page.value,
        pageSize: PAGE,
      })
      messages.value = reset ? res.items : [...messages.value, ...res.items]
      total.value = res.total
      // 原版：进入邮箱即打开第一封（不标记已读）；当前选中仍在列表里、或是链接指定的那封（?message=）就保留
      const keepPinned = pinnedId !== null && selectedId.value === pinnedId
      if (reset && !keepPinned && !messages.value.some((m) => m.id === selectedId.value)) {
        const first = messages.value[0]
        if (first) void open(first.id, { auto: true })
        else {
          selectedId.value = null
          message.value = null
        }
      }
    }
  } catch (error) {
    listError.value = errorText(error)
  } finally {
    listLoading.value = false
  }
}
/* 左栏计数：收件箱 / 各判定 / 未读 / 草稿（每项只取 total） */
const counts = reactive({ inbox: 0, inquiry: 0, review: 0, spam: 0, unread: 0, drafts: 0 })
async function loadCounts(): Promise<void> {
  if (!accounts.value.length) return
  if (restrictedSelected.value) {
    Object.assign(counts, { inbox: 0, inquiry: 0, review: 0, spam: 0, unread: 0, drafts: 0 })
    return
  }
  const acc = accountId.value || undefined
  const q = (extra: Partial<api.MessageQuery>) =>
    api
      .listEmailMessages({ accountId: acc, folder: 'inbox', page: 1, pageSize: 1, ...extra })
      .then((r) => r.total)
      .catch(() => 0)
  const [inbox, inquiry, review, spam, unread, drafts] = await Promise.all([
    q({}),
    q({ verdict: 'inquiry' }),
    q({ verdict: 'review' }),
    q({ verdict: 'spam' }),
    q({ unread: 1 }),
    api
      .listEmailDrafts({ accountId: acc })
      .then((list) => list.filter((d) => d.status !== 'sent').length)
      .catch(() => 0),
  ])
  Object.assign(counts, { inbox, inquiry, review, spam, unread, drafts })
}

async function loadMore(): Promise<void> {
  page.value += 1
  await loadList(false)
}

let searchTimer = 0
watch(query, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void loadList(), 300)
})
watch(accountId, () => void loadCounts())
watch([folder, verdict, unreadOnly, accountId], () => {
  void loadList()
  void router.replace({
    query: {
      ...(accountId.value ? { account: accountId.value } : {}),
      ...(folder.value !== 'inbox' ? { folder: folder.value } : {}),
      ...(folder.value === 'inbox' && verdict.value ? { verdict: verdict.value } : {}),
    },
  })
})

/* ── 阅读 ── */
const selectedId = ref<string | null>(null)
/** ?message= 指定的那封：不在当前页列表里也不被“自动打开第一封”顶掉 */
let pinnedId: string | null = null
const message = ref<api.EmailMessage | null>(null)
const messageLoading = ref(false)
const messageError = ref('')
const html = ref<string | null>(null)
const showHtml = ref(false)

async function open(id: string, opts: { auto?: boolean } = {}): Promise<void> {
  selectedId.value = id
  quickReply.value = ''
  activeDraft.value = null
  messageLoading.value = true
  messageError.value = ''
  html.value = null
  showHtml.value = false
  try {
    const m = await api.getEmailMessage(id)
    // 自动打开第一封和用户点选可能交错返回：只认最后一次选择
    if (selectedId.value !== id) return
    message.value = m
    if (!m.text.trim() && m.hasHtml) void toggleHtml()
    if (!m.seen && m.folder === 'inbox' && !opts.auto) {
      void api.patchEmailMessage(id, { seen: true }).catch(() => undefined)
      const row = messages.value.find((x) => x.id === id)
      if (row) row.seen = true
      counts.unread = Math.max(0, counts.unread - 1)
    }
    void loadThreadDrafts()
  } catch (error) {
    if (selectedId.value !== id) return
    messageError.value = errorText(error)
    message.value = null
  } finally {
    if (selectedId.value === id) messageLoading.value = false
  }
}

async function toggleHtml(): Promise<void> {
  if (!message.value) return
  showHtml.value = !showHtml.value
  if (showHtml.value && html.value === null) {
    try {
      html.value = await api.getEmailMessageHtml(message.value.id)
    } catch {
      html.value = ''
      showHtml.value = false
      toast.error(t('mailbox.kdq1tqo'))
    }
  }
}

function patchRow(m: api.EmailMessage): void {
  message.value = m
  const row = messages.value.find((x) => x.id === m.id)
  if (row)
    Object.assign(row, {
      verdict: m.verdict,
      verdictReason: m.verdictReason,
      verdictSource: m.verdictSource,
      customerId: m.customerId,
      customerName: m.customerName,
      seen: m.seen,
    })
}

/* 判定 */
const classifying = ref(false)
async function setVerdict(v: api.Verdict): Promise<void> {
  if (!message.value || message.value.verdict === v) return
  patchRow(await api.patchEmailMessage(message.value.id, { verdict: v }))
  void loadCounts()
  toast.success(t('mailbox.k1oek9y9', [VERDICT_LABEL[v]]))
}
async function reclassify(): Promise<void> {
  if (!message.value) return
  classifying.value = true
  try {
    patchRow(await api.classifyEmailMessage(message.value.id, true))
  } finally {
    classifying.value = false
  }
}

/* 客户 */
const showCreateCustomer = ref(false)
const customerForm = reactive({ company: '', country: '', website: '' })
const creatingCustomer = ref(false)
const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|qq|163|126|foxmail|icloud|me|aol|proton|protonmail|yandex|mail|gmx|sina|sohu)\./i
function guessCompany(m: api.EmailMessage): { company: string; website: string } {
  const party = m.folder === 'sent' ? m.to[0] : m.from
  const domain = (party?.address.split('@')[1] ?? '').toLowerCase()
  if (!domain || FREE_MAIL.test(domain)) return { company: party?.name || party?.address || '', website: '' }
  const main = domain.replace(/^(mail|www)\./, '').split('.')[0]
  return { company: main.charAt(0).toUpperCase() + main.slice(1).replace(/-/g, ' '), website: `https://${domain}` }
}
function openCreateCustomer(): void {
  if (!message.value) return
  Object.assign(customerForm, { ...guessCompany(message.value), country: '' })
  customerDuplicates.value = null
  showCreateCustomer.value = true
}
/** 从邮件建客户时查重命中的已有客户 */
const customerDuplicates = ref<api.CustomerDuplicate[] | null>(null)
async function createCustomer(force = false): Promise<void> {
  if (!message.value) return
  creatingCustomer.value = true
  customerDuplicates.value = null
  try {
    const res = await api.createCustomerFromEmail(
      message.value.id,
      {
        company: customerForm.company.trim() || undefined,
        country: customerForm.country.trim() || undefined,
        website: customerForm.website.trim() || undefined,
        ...(force ? { force: true } : {}),
      },
      { silent: true },
    )
    patchRow(res.message)
    showCreateCustomer.value = false
    toast.success(t('mailbox.k1idnbmq', [res.customer.company]))
    void loadList()
  } catch (error) {
    const found = api.customerDuplicatesOf(error)
    if (found) customerDuplicates.value = found
    else toast.error(emailErrorText(error))
  } finally {
    creatingCustomer.value = false
  }
}
const showPicker = ref(false)
async function link(customer: api.Customer): Promise<void> {
  if (!message.value) return
  showPicker.value = false
  patchRow(await api.linkEmailToCustomer(message.value.id, customer.id))
  toast.success(t('mailbox.kwq9qsk', [customer.company]))
}
async function unlink(): Promise<void> {
  if (!message.value) return
  patchRow(await api.patchEmailMessage(message.value.id, { customerId: null }))
}

/* 附件 */
async function download(att: api.EmailAttachment): Promise<void> {
  try {
    downloadBlob(await api.downloadEmailAttachment(att.id), att.filename)
  } catch {
    /* 全局 toast 已提示 */
  }
}

/* ── 草稿 / AI ── */
const activeDraft = ref<api.EmailDraft | null>(null)
const threadDrafts = ref<api.EmailDraft[]>([])
async function loadThreadDrafts(): Promise<void> {
  const m = message.value
  if (!m) return
  try {
    const list = await api.listEmailDrafts({ accountId: m.accountId })
    threadDrafts.value = list.filter((d) => d.replyToMessageId === m.id && d.status !== 'sent')
  } catch {
    threadDrafts.value = []
  }
}
const aiForm = reactive({ instructions: '', quoteId: '' })
const showAi = ref(false)
const generating = ref(false)
const aiError = ref('')
const customerQuotes = ref<api.Quote[]>([])
async function openAi(): Promise<void> {
  aiError.value = ''
  showAi.value = true
  customerQuotes.value = message.value?.customerId
    ? await api.listQuotesForCustomer(message.value.customerId).catch(() => [])
    : []
}
async function generate(): Promise<void> {
  if (!message.value) return
  generating.value = true
  aiError.value = ''
  try {
    const draft = await api.generateEmailDraft({
      messageId: message.value.id,
      accountId: message.value.accountId,
      customerId: message.value.customerId ?? undefined,
      quoteId: aiForm.quoteId || undefined,
      instructions: aiForm.instructions.trim() || undefined,
    })
    if (aiForm.quoteId) {
      activeDraft.value = await api.updateEmailDraft(draft.id, { attachQuotePdf: true })
    } else activeDraft.value = draft
    showAi.value = false
    threadDrafts.value = [activeDraft.value, ...threadDrafts.value]
    await nextTick()
    document.querySelector('[data-testid="draft-editor"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    aiError.value = emailErrorText(error)
  } finally {
    generating.value = false
  }
}
async function replyManually(): Promise<void> {
  if (!message.value) return
  activeDraft.value = await api.createEmailDraft({
    accountId: message.value.accountId,
    replyToMessageId: message.value.id,
  })
  threadDrafts.value = [activeDraft.value, ...threadDrafts.value]
}
async function compose(): Promise<void> {
  const acc = currentAccount.value ?? accounts.value[0]
  if (!acc) return
  folder.value = 'drafts'
  const draft = await api.createEmailDraft({ accountId: acc.id })
  drafts.value = [draft, ...drafts.value]
  openDraft(draft)
}
function openDraft(d: api.EmailDraft): void {
  selectedId.value = `draft:${d.id}`
  message.value = null
  activeDraft.value = d
}
function onDraftSaved(d: api.EmailDraft): void {
  activeDraft.value = d
  const i = drafts.value.findIndex((x) => x.id === d.id)
  if (i >= 0) drafts.value[i] = d
  const j = threadDrafts.value.findIndex((x) => x.id === d.id)
  if (j >= 0) threadDrafts.value[j] = d
}
function onDraftSent(res: { draft: api.EmailDraft; message: api.EmailMessage }): void {
  drafts.value = drafts.value.filter((d) => d.id !== res.draft.id)
  threadDrafts.value = threadDrafts.value.filter((d) => d.id !== res.draft.id)
  activeDraft.value = res.draft
}
function onDraftDeleted(id: string): void {
  drafts.value = drafts.value.filter((d) => d.id !== id)
  threadDrafts.value = threadDrafts.value.filter((d) => d.id !== id)
  activeDraft.value = null
  if (selectedId.value === `draft:${id}`) selectedId.value = null
}

/* 底部回复框（原版）：输入文字 → 建回信草稿 → 走编辑器的发送确认（不会直接发出） */
const quickReply = ref('')
const editorRef = ref<{ send: () => Promise<void> } | null>(null)
const quickBusy = ref(false)
async function sendQuick(): Promise<void> {
  if (!message.value || !quickReply.value.trim()) return
  quickBusy.value = true
  try {
    const draft = await api.createEmailDraft({ accountId: message.value.accountId, replyToMessageId: message.value.id })
    activeDraft.value = await api.updateEmailDraft(draft.id, {
      text: `${quickReply.value.trim()}\n\n${draft.text}`.trim(),
    })
    threadDrafts.value = [activeDraft.value, ...threadDrafts.value]
    quickReply.value = ''
    await nextTick()
    await editorRef.value?.send()
  } catch (error) {
    toast.error(emailErrorText(error))
  } finally {
    quickBusy.value = false
  }
}
/** 生成报价：已关联客户 → 新建报价并带上客户；未关联 → 先建客户 */
function makeQuote(): void {
  const m = message.value
  if (!m) return
  if (m.customerId) void router.push({ path: '/quotation/new', query: { customer: m.customerId } })
  else {
    toast.info(t('mailx.quoteNeedsCustomer'))
    openCreateCustomer()
  }
}
const initials = (a: api.EmailAddress | undefined) => {
  const src = (a?.name || a?.address || '?').trim()
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}
const visibleAttachments = computed(() => message.value?.attachments.filter((a) => !a.inline) ?? [])
const attachmentBytes = computed(() => visibleAttachments.value.reduce((n, a) => n + a.size, 0))
const accountState = (a: api.EmailAccount) =>
  a.status.state === 'syncing'
    ? t('mailx.accSyncing')
    : a.status.state === 'error' || a.status.state === 'needs_reauth' || a.secretError
      ? t('mailx.accError')
      : a.status.lastSyncAt
        ? t('mailx.accOk', [mailTime(a.status.lastSyncAt)])
        : t('mailx.accIdle')

/* 从报价页“邮件发送给客户”过来：?draft=id 直接打开那封草稿 */
async function openDraftFromQuery(): Promise<void> {
  const id = typeof route.query.draft === 'string' ? route.query.draft : ''
  if (!id) return
  try {
    const d = await api.getEmailDraft(id)
    folder.value = 'drafts'
    await nextTick()
    openDraft(d)
  } catch {
    /* 草稿不存在：忽略 */
  }
}

/* 链接带来的 ?message= / ?compose= / ?verdict=（首次进入，或已在邮箱页时再次跳转） */
async function openMessageFromQuery(id: string): Promise<void> {
  try {
    const m = await api.getEmailMessage(id)
    const target: Folder = m.folder === 'sent' ? 'sent' : 'inbox'
    if (folder.value !== target) folder.value = target
    if (target === 'inbox' && verdict.value && m.verdict !== verdict.value) verdict.value = ''
  } catch {
    return /* 邮件不存在：照常打开收件箱 */
  }
  pinnedId = id
  await open(id)
}
async function composeFromQuery(): Promise<void> {
  const acc = currentAccount.value ?? accounts.value[0]
  if (!acc) return
  const to = qstr(route.query.to).trim()
  const customerId = qstr(route.query.customer) || null
  try {
    const draft = await api.createEmailDraft({
      accountId: acc.id,
      ...(to ? { to: [{ name: '', address: to }] } : {}),
      ...(customerId ? { customerId } : {}),
    })
    folder.value = 'drafts'
    await nextTick()
    drafts.value = [draft, ...drafts.value.filter((d) => d.id !== draft.id)]
    openDraft(draft)
  } catch (error) {
    toast.error(errorText(error))
  }
}
async function applyLinkQuery(): Promise<void> {
  if (!accounts.value.length) return
  if (qstr(route.query.compose) === '1') await composeFromQuery()
  else if (qstr(route.query.message)) await openMessageFromQuery(qstr(route.query.message))
}
watch(
  () => [route.query.message, route.query.compose, route.query.verdict, route.query.q] as const,
  ([msg, comp, v, q], prev) => {
    if (!prev) return
    // 我们自己的 router.replace 会去掉这些参数：只在链接带来新值时响应
    if (v !== undefined && verdictParam(v) !== verdict.value) {
      folder.value = 'inbox'
      verdict.value = verdictParam(v)
    }
    if (q !== undefined && qstr(q) !== query.value) query.value = qstr(q)
    if ((msg && msg !== prev[0]) || (comp && comp !== prev[1])) void applyLinkQuery()
  },
)

/* ── 同步 ── */
let pollTimer = 0
async function sync(): Promise<void> {
  const list = currentAccount.value ? [currentAccount.value] : accounts.value
  for (const acc of list) {
    acc.status.state = 'syncing'
    void api.syncEmailAccount(acc.id, { wait: false }).catch(() => undefined)
  }
  window.clearInterval(pollTimer)
  pollTimer = window.setInterval(async () => {
    const next = await api.listEmailAccounts({ silent: true }).catch(() => null)
    if (!next) return
    accounts.value = next
    if (!next.some((a) => a.status.state === 'syncing')) {
      window.clearInterval(pollTimer)
      void loadList()
      void loadCounts()
    }
  }, 1500)
}

/* ── 实时事件 ── */
const offs: Array<() => void> = []
onMounted(async () => {
  await loadAccounts()
  await openDraftFromQuery()
  const linked = qstr(route.query.compose) === '1' || !!qstr(route.query.message)
  if (linked) await applyLinkQuery()
  await loadList()
  void loadCounts()
  offs.push(
    onServerEvent('email.account', (data) => {
      const acc = (data as { account: api.EmailAccount }).account
      const i = accounts.value.findIndex((a) => a.id === acc.id)
      // 推送里没有按请求者计算的 contentAccess，保留列表接口给的值
      if (i >= 0) accounts.value[i] = { ...acc, contentAccess: acc.contentAccess ?? accounts.value[i]!.contentAccess }
    }),
    onServerEvent('email.new', (data) => {
      const d = data as { accountId: string; messageIds: string[]; inquiry: number }
      if (accountId.value && d.accountId !== accountId.value) return
      toast.info(t('mailbox.k1422ipb', [d.messageIds.length, d.inquiry ? t('mailbox.ku6z4fj', [d.inquiry]) : '']))
      if (folder.value === 'inbox') void loadList()
      void loadCounts()
    }),
    onServerEvent('email.draft', (data) => {
      const d = (data as { draft: api.EmailDraft }).draft
      if (d.source === 'agent' && d.status === 'draft')
        toast.info(t('mailbox.k1px25u7', [d.subject || t('mailbox.k1c121vb')]))
      if (folder.value === 'drafts') void loadList()
    }),
  )
})
onBeforeUnmount(() => {
  offs.forEach((off) => off())
  window.clearInterval(pollTimer)
})

const VERDICT_FILTERS: Array<{ value: '' | api.Verdict | 'none'; label: string }> = [
  { value: '', label: t('mailbox.kx69ng9') },
  { value: 'inquiry', label: t('mailbox.k8ab8zk') },
  { value: 'review', label: t('mailbox.kjfifnh') },
  { value: 'spam', label: t('mailbox.k2qemew') },
]
const accountEmail = (id: string) => accounts.value.find((a) => a.id === id)?.email ?? ''
const counterpart = (m: api.EmailMessageSummary) =>
  m.folder === 'sent'
    ? t('mailbox.k1odq12e', [m.to[0]?.name || m.to[0]?.address || '—'])
    : m.from.name || m.from.address
async function confirmDeleteDraft(d: api.EmailDraft): Promise<void> {
  const ok = await confirmDialog({
    title: t('mailbox.k1s4dnps'),
    message: d.subject || t('mailbox.k1c121vb'),
    confirmText: t('mailbox.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  await api.deleteEmailDraft(d.id)
  onDraftDeleted(d.id)
}
</script>

<template>
  <aside class="side mail-side" :aria-label="$t('mailx.sideLabel')">
    <div class="side-head">
      <h2 class="side-title">{{ $t('mailbox.k182knuk') }}</h2>
      <button
        v-if="accounts.length"
        type="button"
        class="link"
        :disabled="!can('data:write')"
        :title="can('data:write') ? '' : denyReason('data:write')"
        @click="compose"
      >
        {{ $t('mailbox.k1indx29') }}
      </button>
    </div>
    <label v-if="accounts.length" class="side-search">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <span class="sr-only">{{ $t('mailbox.kys8a40') }}</span>
      <input v-model="query" type="search" :placeholder="$t('mailx.searchPh')" spellcheck="false" />
    </label>
    <nav class="side-body">
      <template v-if="accounts.length">
        <div role="tablist" :aria-label="$t('mailbox.kjog0tl')" aria-orientation="vertical">
          <button
            type="button"
            role="tab"
            class="nav-row folder"
            :class="{ on: folder === 'inbox' && !verdict }"
            :aria-selected="folder === 'inbox'"
            @click="((folder = 'inbox'), (verdict = ''))"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="5.2" width="18" height="13.6" rx="2.4" />
              <path d="m3.8 7 7.3 5.3a1.5 1.5 0 0 0 1.8 0L20.2 7" />
            </svg>
            {{ $t('mailbox.folderInbox') }}<span class="count">{{ counts.inbox }}</span>
          </button>
          <button
            v-for="v in ['inquiry', 'review', 'spam'] as const"
            :key="v"
            type="button"
            class="nav-row sub"
            :class="{ on: folder === 'inbox' && verdict === v }"
            :aria-pressed="folder === 'inbox' && verdict === v"
            @click="((folder = 'inbox'), (verdict = v))"
          >
            {{ VERDICT_LABEL[v] }}<span class="count">{{ counts[v] }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="nav-row"
            :class="{ on: folder === 'sent' }"
            :aria-selected="folder === 'sent'"
            @click="folder = 'sent'"
          >
            {{ $t('mailbox.folderSent') }}
          </button>
          <button
            type="button"
            role="tab"
            class="nav-row"
            :class="{ on: folder === 'drafts' }"
            :aria-selected="folder === 'drafts'"
            @click="folder = 'drafts'"
          >
            {{ $t('mailbox.folderDrafts') }}<span v-if="counts.drafts" class="count">{{ counts.drafts }}</span>
          </button>
        </div>

        <div class="side-label">{{ $t('mailx.rules') }}</div>
        <RouterLink class="nav-row" to="/settings/rules">{{ $t('mailx.inquiryRules') }}</RouterLink>
        <RouterLink class="nav-row" to="/settings/mailbox">{{ $t('mailx.accountSettings') }}</RouterLink>

        <div class="side-label">{{ $t('mailx.accounts') }}</div>
        <button
          v-if="accounts.length > 1"
          type="button"
          class="nav-row"
          :class="{ on: !accountId }"
          :aria-pressed="!accountId"
          @click="accountId = ''"
        >
          {{ $t('mailbox.k1iwqum0') }}
        </button>
        <div v-for="a in accounts" :key="a.id" class="acct-row">
          <button
            type="button"
            class="nav-row"
            :class="{ on: accountId === a.id }"
            :aria-pressed="accountId === a.id"
            :title="a.email"
            @click="accountId = accountId === a.id && accounts.length > 1 ? '' : a.id"
          >
            <span class="acct-mail">{{ a.email }}</span>
            <span
              class="dot"
              :class="{
                bad: a.status.state === 'error' || a.status.state === 'needs_reauth' || !!a.secretError,
                busy: a.status.state === 'syncing',
              }"
              aria-hidden="true"
            ></span>
          </button>
          <div class="acct-state">{{ accountState(a) }}</div>
          <div v-if="a.contentAccess === 'restricted'" class="acct-state" data-testid="acct-restricted">
            {{ $t('mailx.restrictedShort') }}
          </div>
          <div v-else-if="a.adminCanRead && a.contentAccess === 'own'" class="acct-state" data-testid="acct-admin-visible">
            {{ $t('mailx.adminCanRead') }}
          </div>
        </div>
      </template>
    </nav>
  </aside>

  <main class="main mail-main">
    <h1 class="sr-only">{{ $t('mailbox.k182knuk') }}</h1>
    <div v-if="accountsLoading" class="doc"><StateBlock state="loading" /></div>
    <div v-else-if="accountsError" class="doc">
      <StateBlock state="error" :message="accountsError" @retry="loadAccounts" />
    </div>
    <div v-else-if="!accounts.length" class="doc">
      <StateBlock state="empty" :title="$t('mailbox.k1squazo')" :message="$t('mailbox.kihwckz')">
        <RouterLink class="kbtn primary" to="/settings/mailbox">{{ $t('mailbox.k1p3m3av') }}</RouterLink>
        <RouterLink class="kbtn" to="/settings/rules">{{ $t('mailbox.k1n0ieq5') }}</RouterLink>
      </StateBlock>
    </div>

    <div v-else class="mail">
      <!-- 列表 -->
      <section class="mail-list" :aria-label="$t('mailbox.k15kljii')">
        <div v-if="adminNotice" class="note mail-access-note" role="note" data-testid="mail-admin-notice">
          {{ $t('mailx.adminCanReadNote') }}
        </div>
        <div v-if="readingAsAdmin" class="note warn mail-access-note" role="note" data-testid="mail-admin-reading">
          {{ $t('mailx.readingAsAdmin', [currentAccount?.ownerName ?? '']) }}
        </div>
        <div v-if="restrictedSelected" class="note mail-access-note" role="note" data-testid="mail-restricted">
          {{ $t('mailx.restricted') }}
        </div>
        <div class="list-top">
          <span class="lt-title">{{
            folder === 'inbox'
              ? verdict
                ? VERDICT_LABEL[verdict as api.Verdict]
                : $t('mailbox.folderInbox')
              : folder === 'sent'
                ? $t('mailbox.folderSent')
                : $t('mailbox.folderDrafts')
          }}</span>
          <span v-if="folder !== 'drafts'" class="lt-count">{{ $t('mailx.countMails', [total]) }}</span>
          <span class="lt-spacer"></span>
          <span
            v-if="lastSyncAt && !syncing"
            class="lt-sync"
            :title="$t('mailbox.kp1w3fu', [relativeTime(lastSyncAt)])"
            >{{ relativeTime(lastSyncAt) }}</span
          >
          <button type="button" class="lt-btn" data-testid="mail-sync" :disabled="syncing" @click="sync">
            {{ syncing ? $t('mailbox.k14c028q') : $t('mailbox.k1sisn22') }}
          </button>
        </div>
        <div v-if="folder === 'inbox'" class="pills" role="group" :aria-label="$t('mailbox.kdj07fu')">
          <button
            v-for="f in VERDICT_FILTERS"
            :key="f.value"
            type="button"
            class="pill"
            :class="{ on: verdict === f.value }"
            :aria-pressed="verdict === f.value"
            @click="verdict = f.value"
          >
            {{ f.label
            }}<span v-if="f.value && f.value !== 'none'" class="pc">{{ counts[f.value as api.Verdict] }}</span>
          </button>
          <button
            type="button"
            class="pill"
            :class="{ on: unreadOnly }"
            :aria-pressed="unreadOnly"
            @click="unreadOnly = !unreadOnly"
          >
            {{ $t('mailbox.k8d11gi') }}<span class="pc">{{ counts.unread }}</span>
          </button>
        </div>
        <div v-if="accountProblem" class="note warn small-note" role="status">
          <span>
            {{
              $t('fmt.labelled', [
                accountProblem.email,
                accountProblem.secretError ||
                  (accountProblem.status.state === 'needs_reauth'
                    ? $t('mailbox.kt9zb8x')
                    : accountProblem.status.lastError),
              ])
            }}
            <RouterLink to="/settings/mailbox" class="link">{{ $t('mailbox.k18kiipv') }}</RouterLink>
          </span>
        </div>

        <div class="list-body">
          <StateBlock v-if="listLoading && !messages.length && !drafts.length" state="loading" compact />
          <StateBlock v-else-if="listError" state="error" :message="listError" compact @retry="loadList()" />
          <template v-else-if="folder === 'drafts'">
            <StateBlock
              v-if="!drafts.length"
              state="empty"
              :title="$t('mailbox.kavz3nr')"
              :message="$t('mailbox.ktgyj0y')"
              compact
            />
            <div v-for="d in drafts" :key="d.id" class="mrow-wrap">
              <button
                type="button"
                class="mrow"
                :class="{ on: selectedId === `draft:${d.id}` }"
                :aria-current="selectedId === `draft:${d.id}` ? 'true' : undefined"
                @click="openDraft(d)"
              >
                <div class="mrow-top">
                  <span class="who">{{
                    d.to.length ? $t('mailbox.k1odq12e', [d.to[0].name || d.to[0].address]) : $t('mailbox.k6s2cgo')
                  }}</span>
                  <span class="when">{{ mailTime(d.updatedAt) }}</span>
                </div>
                <div class="subj">{{ d.subject || $t('mailbox.k1v84skf') }}</div>
                <div class="snip">{{ d.text.slice(0, 120) }}</div>
                <div class="meta">
                  <span class="vtag" :class="d.status === 'failed' ? 'spam' : 'review'">{{
                    d.status === 'failed'
                      ? $t('mailbox.k1s7g1n0')
                      : d.source === 'ai'
                        ? $t('mailbox.k1s2j35j')
                        : d.source === 'agent'
                          ? $t('mailbox.kvwdhhf')
                          : $t('mailbox.k48glco')
                  }}</span>
                </div>
              </button>
              <button
                v-if="can('data:write')"
                type="button"
                class="row-x"
                :aria-label="$t('mailbox.k19g1bt5', [d.subject])"
                @click="confirmDeleteDraft(d)"
              >
                ×
              </button>
            </div>
          </template>
          <template v-else>
            <StateBlock
              v-if="!messages.length"
              state="empty"
              :title="
                query || verdict || unreadOnly
                  ? $t('mailbox.k1upque6')
                  : folder === 'sent'
                    ? $t('mailbox.kw9qeee')
                    : $t('mailbox.kvfvh6j')
              "
              :message="query || verdict || unreadOnly ? '' : $t('mailbox.ksye7i5')"
              compact
            />
            <button
              v-for="m in messages"
              :key="m.id"
              type="button"
              class="mrow"
              :class="{ on: selectedId === m.id, unread: !m.seen && m.folder === 'inbox' }"
              :aria-current="selectedId === m.id ? 'true' : undefined"
              data-testid="mail-row"
              @click="open(m.id)"
            >
              <div class="mrow-top">
                <span v-if="!m.seen && m.folder === 'inbox'" class="udot" :aria-label="$t('mailbox.k8d11gi')"></span>
                <span class="who" :title="m.folder === 'sent' ? formatAddressList(m.to) : formatAddress(m.from)">{{
                  counterpart(m)
                }}</span>
                <span class="when">{{ mailTime(m.date) }}</span>
              </div>
              <div class="subj" :title="m.subject">{{ m.subject || $t('mailbox.k1v84skf') }}</div>
              <div v-if="m.snippet" class="snip">{{ m.snippet }}</div>
              <div v-if="m.verdict || m.customerName || m.hasAttachments" class="meta">
                <span v-if="m.verdict" class="vtag" :class="m.verdict">{{ VERDICT_LABEL[m.verdict] }}</span>
                <span v-if="m.customerName" class="ctag" :title="$t('mailbox.k6f42eq', [m.customerName])">{{
                  m.customerName
                }}</span>
                <span v-if="m.hasAttachments" class="ctag">{{ $t('mailx.hasAtt') }}</span>
              </div>
            </button>
            <div v-if="messages.length < total" class="more">
              <button type="button" class="kbtn sm" :disabled="listLoading" @click="loadMore">
                {{ $t('mailbox.k1w219i8', [messages.length, total]) }}
              </button>
            </div>
          </template>
        </div>
      </section>

      <!-- 阅读 -->
      <section class="mail-read" :aria-label="$t('mailbox.k1i1k77c')">
        <template v-if="folder === 'drafts' || (selectedId?.startsWith('draft:') && activeDraft)">
          <div v-if="activeDraft" class="read-scroll">
            <div class="read-inner">
              <MailDraftEditor
                :key="activeDraft.id"
                :draft="activeDraft"
                :accounts="accounts"
                @saved="onDraftSaved"
                @sent="onDraftSent"
                @deleted="onDraftDeleted"
                @close="activeDraft = null"
              />
            </div>
          </div>
          <StateBlock v-else state="empty" :title="$t('mailbox.kznsj5i')" :message="$t('mailbox.k1rjkoq4')" />
        </template>
        <StateBlock v-else-if="messageLoading && !message" state="loading" />
        <StateBlock
          v-else-if="messageError"
          state="error"
          :message="messageError"
          @retry="selectedId && open(selectedId)"
        />
        <StateBlock
          v-else-if="!message"
          state="empty"
          :title="$t('mailbox.k17bq7w1')"
          :message="$t('mailbox.k180ne0v')"
        />
        <template v-else>
          <div class="read-scroll">
            <article class="read-inner" data-testid="mail-reader">
              <header class="mail-head">
                <h2 class="read-subj">{{ message.subject || $t('mailbox.k1v84skf') }}</h2>
              </header>
              <div class="sender">
                <span class="avatar" aria-hidden="true">{{ initials(message.from) }}</span>
                <div class="sender-txt">
                  <div class="sender-name">
                    <b>{{ message.from.name || message.from.address }}</b>
                    <span v-if="message.from.name" class="addr">&lt;{{ message.from.address }}&gt;</span>
                  </div>
                  <div class="sender-sub">
                    {{ $t('mailx.toLine', [formatAddressList(message.to)]) }}
                    <template v-if="message.cc.length">
                      · {{ $t('mailbox.kk5gb7k') }} {{ formatAddressList(message.cc) }}</template
                    >
                    · <time>{{ new Date(message.date).toLocaleString(intlLocale(), { hour12: false }) }}</time>
                    <template v-if="accounts.length > 1"> · {{ accountEmail(message.accountId) }}</template>
                  </div>
                </div>
                <span v-if="visibleAttachments.length" class="att-sum">{{
                  $t('mailx.attSum', [visibleAttachments.length, formatBytes(attachmentBytes)])
                }}</span>
                <button v-if="message.hasHtml" type="button" class="ghost-btn" @click="toggleHtml">
                  {{ showHtml ? $t('mailbox.kocy230') : $t('mailbox.k1syguyd') }}
                </button>
              </div>

              <!-- 判定条（原版：LULUX 判定为 询盘 · 来源 · 来自 客户 / 依据） -->
              <div
                v-if="message.folder === 'inbox'"
                class="verdict-strip"
                :class="message.verdict ?? ''"
                data-testid="verdict-box"
              >
                <img :src="logoUrl" alt="" class="vs-logo" />
                <div class="vs-txt">
                  <div class="vs-main">
                    {{ $t('mailx.judgedAs') }}
                    <b>{{ message.verdict ? VERDICT_LABEL[message.verdict] : $t('mailbox.knylfph') }}</b>
                    <template v-if="message.verdictSource">
                      · {{ VERDICT_SOURCE_LABEL[message.verdictSource] }}</template
                    >
                    <template v-if="message.customerName">
                      · {{ $t('mailx.fromCustomer') }} <b>{{ message.customerName }}</b></template
                    >
                  </div>
                  <div class="vs-reason" data-testid="verdict-reason">
                    {{ $t('mailx.basis') }}{{ message.verdictReason || $t('mailbox.k1ktg4m3') }}
                  </div>
                </div>
                <div v-if="can('data:write')" class="vs-actions">
                  <div class="segmented sm" role="group" :aria-label="$t('mailbox.k1hygfap')">
                    <button
                      v-for="v in ['inquiry', 'review', 'spam'] as const"
                      :key="v"
                      type="button"
                      :class="{ on: message.verdict === v }"
                      :aria-pressed="message.verdict === v"
                      @click="setVerdict(v)"
                    >
                      {{ VERDICT_LABEL[v] }}
                    </button>
                  </div>
                  <button type="button" class="ghost-btn" :disabled="classifying" @click="reclassify">
                    {{ classifying ? $t('mailbox.kkdc1sa') : $t('mailbox.k17s51b0') }}
                  </button>
                  <button
                    v-if="message.verdict === 'inquiry'"
                    type="button"
                    class="black-btn"
                    data-testid="make-quote"
                    @click="makeQuote"
                  >
                    {{ $t('mailx.makeQuote') }}
                  </button>
                </div>
              </div>

              <!-- 客户 -->
              <div class="cust-line" data-testid="customer-box">
                <span class="k">{{ $t('mailbox.k1v5iwp2') }}</span>
                <template v-if="message.customerId">
                  <RouterLink class="link" :to="`/customers/${message.customerId}`">{{
                    message.customerName
                  }}</RouterLink>
                  <button v-if="can('data:write')" type="button" class="text-btn" @click="unlink">
                    {{ $t('mailbox.k1rf2myq') }}
                  </button>
                </template>
                <template v-else>
                  <span class="muted">{{
                    $t('mailbox.k1wp9msp', [message.folder === 'sent' ? $t('mailbox.kmwupjj') : $t('mailbox.kfosvh5')])
                  }}</span>
                  <template v-if="can('data:write')">
                    <button type="button" class="ghost-btn" data-testid="create-customer" @click="openCreateCustomer">
                      {{ $t('mailbox.k2dhy3o') }}
                    </button>
                    <button type="button" class="ghost-btn" @click="showPicker = true">
                      {{ $t('mailbox.kbk85wd') }}
                    </button>
                  </template>
                </template>
              </div>

              <!-- 正文 -->
              <div class="body-wrap">
                <iframe
                  v-if="showHtml && html"
                  class="mail-html"
                  sandbox=""
                  referrerpolicy="no-referrer"
                  :srcdoc="html"
                  :title="$t('mailbox.k1srh177')"
                ></iframe>
                <pre v-else class="mail-text">{{ message.text || $t('mailbox.k1b0znjf') }}</pre>
                <p v-if="showHtml" class="muted small">{{ $t('mailbox.kvidgh6') }}</p>
                <p v-if="message.truncated" class="muted small">{{ $t('mailbox.k1i274xw') }}</p>
              </div>

              <!-- 附件 -->
              <ul v-if="visibleAttachments.length" class="att-list" :aria-label="$t('mailbox.k16pwtik')">
                <li v-for="att in visibleAttachments" :key="att.id">
                  <button
                    type="button"
                    class="att"
                    :aria-label="$t('mailbox.kpi7cuj', [att.filename])"
                    @click="download(att)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M14 3.5H7.2A2.2 2.2 0 0 0 5 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5z"
                      />
                      <path d="M14 3.5v5h5" />
                    </svg>
                    <span class="att-name">{{ att.filename }}</span>
                    <span class="att-size">{{ formatBytes(att.size) }}</span>
                  </button>
                </li>
              </ul>

              <!-- 草稿 / AI 起草 -->
              <div
                v-if="message.folder === 'inbox' && can('data:write') && (activeDraft || showAi || threadDrafts.length)"
                class="reply"
              >
                <div v-for="d in threadDrafts.filter((x) => x.id !== activeDraft?.id)" :key="d.id" class="draft-chip">
                  <span class="vtag review">{{
                    d.source === 'ai'
                      ? $t('mailbox.kf6ntx')
                      : d.source === 'agent'
                        ? $t('mailbox.ks7aq0c')
                        : $t('mailbox.k48glco')
                  }}</span>
                  <span class="snip1">{{ d.subject }} · {{ relativeTime(d.updatedAt) }}</span>
                  <button type="button" class="ghost-btn" @click="activeDraft = d">{{ $t('mailbox.kg65qkn') }}</button>
                </div>
                <MailDraftEditor
                  v-if="activeDraft"
                  ref="editorRef"
                  :key="activeDraft.id"
                  :draft="activeDraft"
                  :accounts="accounts"
                  @saved="onDraftSaved"
                  @sent="onDraftSent"
                  @deleted="onDraftDeleted"
                  @close="activeDraft = null"
                />
                <div v-else-if="showAi" class="ai-box">
                  <label class="field">
                    <span class="field-label">{{ $t('mailbox.ksll8ri') }}</span>
                    <input
                      v-model="aiForm.instructions"
                      class="input"
                      name="instructions"
                      :placeholder="$t('mailbox.klzggve')"
                      @keydown.enter.prevent="generate"
                    />
                  </label>
                  <label v-if="customerQuotes.length" class="field">
                    <span class="field-label">{{ $t('mailbox.k1go8apc') }}</span>
                    <select v-model="aiForm.quoteId" class="select">
                      <option value="">{{ $t('mailbox.k1n7tjuq') }}</option>
                      <option v-for="q in customerQuotes" :key="q.id" :value="q.id">
                        {{ q.number }} · {{ q.currency }} {{ q.subtotal }}
                      </option>
                    </select>
                  </label>
                  <p class="field-hint">{{ $t('mailbox.k1jrlhsn') }}</p>
                  <p v-if="aiError" class="field-error" role="alert">
                    {{ aiError }}
                    <RouterLink v-if="aiError.includes($t('mailbox.k16g5qd9'))" to="/settings/models" class="link">{{
                      $t('mailbox.k19l6ydg')
                    }}</RouterLink>
                  </p>
                  <div class="hstack">
                    <button
                      type="button"
                      class="kbtn primary"
                      data-testid="ai-generate"
                      :disabled="generating"
                      @click="generate"
                    >
                      {{ generating ? $t('mailbox.k1u691bt') : $t('mailbox.kb23gft') }}
                    </button>
                    <button type="button" class="kbtn" :disabled="generating" @click="showAi = false">
                      {{ $t('mailbox.kldkknc') }}
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>

          <!-- 底部回复框（原版） -->
          <div v-if="message.folder === 'inbox' && can('data:write') && !activeDraft && !showAi" class="reply-bar">
            <div class="reply-pill">
              <label class="sr-only" for="quick-reply">{{ $t('mailx.replyTo', [counterpart(message)]) }}</label>
              <input
                id="quick-reply"
                v-model="quickReply"
                :placeholder="$t('mailx.replyTo', [counterpart(message)]) + '…'"
                @keydown.enter.prevent="sendQuick"
              />
              <button type="button" class="rp-btn" :title="$t('mailbox.k16lxuy7')" @click="replyManually">
                {{ $t('mailx.fullEditor') }}
              </button>
              <button type="button" class="rp-btn" data-testid="ai-draft" @click="openAi">
                {{ $t('mailx.aiDraft') }}
              </button>
              <button
                type="button"
                class="rp-send"
                :disabled="!quickReply.trim() || quickBusy"
                :title="$t('mailx.sendHint')"
                @click="sendQuick"
              >
                {{ $t('mailx.send') }}
              </button>
            </div>
          </div>
        </template>
      </section>
    </div>

    <UiModal
      v-if="showCreateCustomer"
      :title="$t('mailbox.k2dhy3o')"
      :subtitle="$t('mailbox.k1unk74e')"
      :width="460"
      @close="showCreateCustomer = false"
    >
      <form id="cust-form" class="stack" @submit.prevent="createCustomer()">
        <label class="field"
          ><span class="field-label">{{ $t('mailbox.k159zy9b') }}</span
          ><input v-model="customerForm.company" class="input" name="company" autofocus
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('mailbox.k1mq5d31') }}</span
          ><input v-model="customerForm.country" class="input" name="country" :placeholder="$t('mailbox.k9ylfzl')"
        /></label>
        <label class="field"
          ><span class="field-label">{{ $t('mailbox.k14bpx7p') }}</span
          ><input v-model="customerForm.website" class="input" name="website"
        /></label>
        <CustomerDuplicateNotice
          v-if="customerDuplicates"
          :duplicates="customerDuplicates"
          :busy="creatingCustomer"
          @back="customerDuplicates = null"
          @force="createCustomer(true)"
        />
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showCreateCustomer = false">{{ $t('mailbox.kldkknc') }}</button>
        <button type="submit" form="cust-form" class="kbtn primary" :disabled="creatingCustomer">
          {{ creatingCustomer ? $t('mailbox.k1w9441s') : $t('mailbox.kfj06tp') }}
        </button>
      </template>
    </UiModal>
    <CustomerPicker
      v-if="showPicker"
      :title="$t('mailbox.k1lkt1tn')"
      :initial-query="message?.from.address.split('@')[1]?.split('.')[0] ?? ''"
      @close="showPicker = false"
      @pick="link"
    />
  </main>
</template>

<style scoped>
.mail-access-note {
  margin: 8px 12px 0;
  font-size: 12px;
}
/* ── 左栏（原版：文件夹 / 规则 / 账户） ── */
.mail-side .link:disabled {
  opacity: 0.5;
}
.nav-row svg {
  width: 17px;
  height: 17px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nav-row.sub {
  padding-left: 34px;
}
.acct-row .nav-row {
  gap: 8px;
}
.acct-mail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acct-row .dot.bad {
  background: var(--danger);
}
.acct-row .dot.busy {
  background: var(--text-tertiary);
}
.acct-state {
  padding: 0 10px 6px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

/* ── 主区：列表 + 阅读 ── */
.mail-main {
  min-width: 0;
}
.mail {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(300px, 366px) minmax(0, 1fr);
}
.mail-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.list-top {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 0 18px;
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
.list-top button {
  -webkit-app-region: no-drag;
}
.lt-title {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.lt-count,
.lt-sync {
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.lt-spacer {
  flex: 1;
}
.lt-btn {
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 4px 6px;
  border-radius: 6px;
}
.lt-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 14px 10px;
}
.pill {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: var(--surface-muted);
  font: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pill:hover {
  color: var(--text);
}
.pill.on {
  background: var(--text);
  color: var(--on-strong);
  font-weight: 500;
}
.pc {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.small-note {
  margin: 0 12px 8px;
  font-size: 12px;
  padding: 8px 10px;
}
.list-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.mrow-wrap {
  position: relative;
}
.mrow-wrap .mrow {
  padding-right: 40px;
}
.mrow {
  width: 100%;
  display: block;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-left: 3px solid transparent;
  background: none;
  padding: calc(13px * var(--density, 1)) 18px calc(13px * var(--density, 1)) 15px;
  font: inherit;
  color: var(--text);
}
.mrow:hover {
  background: var(--surface-hover);
}
.mrow.on {
  background: var(--surface-soft);
  border-left-color: var(--text);
}
.mrow-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.udot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--text);
}
.who {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.mrow.unread .who {
  color: var(--text);
  font-weight: 600;
}
.when {
  font-size: 11.5px;
  color: var(--text-tertiary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.subj {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrow.unread .subj {
  color: var(--text);
}
.snip {
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.vtag,
.ctag {
  flex: none;
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.vtag.inquiry {
  background: var(--good-soft);
  color: var(--good);
  font-weight: 600;
}
.vtag.spam {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.vtag.review {
  background: var(--info-soft);
  color: var(--info-text);
}
.ctag {
  display: inline-block;
  line-height: 20px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-x {
  display: grid;
  place-items: center;
  font-size: 16px;
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-tertiary);
}
.row-x:hover,
.row-x:focus-visible {
  background: var(--surface-hover);
  color: var(--danger);
}
.more {
  padding: 10px;
  text-align: center;
}

/* ── 阅读区 ── */
.mail-read {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.read-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.read-inner {
  max-width: 900px;
  padding: 0 26px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mail-head {
  padding-top: 18px;
  -webkit-app-region: drag;
}
.read-subj {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.sender {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.avatar {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.sender-txt {
  flex: 1;
  min-width: 0;
}
.sender-name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sender-name .addr {
  margin-left: 4px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.sender-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}
.att-sum {
  flex: none;
  font-size: 12px;
  color: var(--text-tertiary);
}
.ghost-btn,
.black-btn {
  flex: none;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
}
.ghost-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}
.black-btn {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
  font-weight: 500;
}
.verdict-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  box-shadow: inset 0 0 0 1px var(--line);
}
.vs-logo {
  width: 26px;
  height: 26px;
  object-fit: contain;
  flex: none;
}
.vs-txt {
  flex: 1;
  min-width: 220px;
}
.vs-main {
  font-size: 13px;
  color: var(--text-secondary);
}
.vs-main b {
  color: var(--text);
  font-weight: 600;
}
.verdict-strip.inquiry .vs-main > b:first-child {
  color: var(--good);
}
.verdict-strip.spam .vs-main > b:first-child {
  color: var(--danger-text);
}
.vs-reason {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}
.vs-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.segmented.sm button {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.cust-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12.5px;
}
.cust-line .k {
  color: var(--text-tertiary);
}
.text-btn {
  border: 0;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-tertiary);
  text-decoration: underline;
}
.muted {
  color: var(--text-tertiary);
}
.small {
  font-size: 12px;
}
.mail-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.75;
}
.mail-html {
  width: 100%;
  height: 520px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}
.att-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.att {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  font: inherit;
  font-size: 13px;
  color: var(--text);
}
.att svg {
  width: 15px;
  height: 15px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-secondary);
}
.att:hover,
.att:focus-visible {
  background: var(--surface-soft);
}
.att-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-size {
  font-size: 11px;
  color: var(--text-tertiary);
}
.reply {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.draft-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.snip1 {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.ai-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  box-shadow: inset 0 0 0 1px var(--line);
}
.reply-bar {
  flex: none;
  padding: 12px 26px 16px;
  border-top: 1px solid var(--line);
  border-top-left-radius: 22px;
}
.reply-pill {
  max-width: 560px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 16px;
  border-radius: 14px;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.reply-pill:focus-within {
  box-shadow: inset 0 0 0 1px var(--text-tertiary);
}
.reply-pill input {
  flex: 1;
  min-width: 0;
  height: 34px;
  border: 0;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 13.5px;
  color: var(--text);
}
.reply-pill input::placeholder {
  color: var(--text-tertiary);
}
.rp-btn,
.rp-send {
  flex: none;
  height: 32px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
}
.rp-btn:hover {
  background: var(--surface-hover);
}
.rp-send {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
  font-weight: 500;
}
.rp-send:disabled {
  cursor: default;
}
.cust-line .link,
.small-note .link {
  text-decoration: underline;
}
@media (max-width: 1180px) {
  .mail {
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .read-inner {
    padding: 0 18px 24px;
  }
}
</style>
