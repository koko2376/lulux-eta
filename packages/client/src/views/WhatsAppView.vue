<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SideSlot from '../components/shell/SideSlot.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import WhatsAppProxyForm from '../components/whatsapp/WhatsAppProxyForm.vue'
import WhatsAppProfilePanel from '../components/WhatsAppProfilePanel.vue'
import { WHATSAPP_TABS, tabActive } from '../lib/nav'
import {
  ApiError,
  WHATSAPP_TRANSLATOR_TARGETS,
  acceptWhatsAppRisk,
  createWhatsAppConversation,
  logoutWhatsApp,
  refreshWhatsAppQr,
  requestWhatsAppPairingCode,
  startWhatsAppLink,
  stopWhatsAppLink,
  translateWhatsAppText,
  type WhatsAppConversation,
  type WhatsAppConversationFilter,
  type WhatsAppLinkMode,
  type WhatsAppMessage,
  type WhatsAppStatus,
  type WhatsAppTranslation,
  type WhatsAppTranslatorTarget,
} from '../api'
import { copyText } from '../lib/clipboard'
import {
  loadWhatsAppConversations,
  loadWhatsAppMessages,
  mergeWhatsAppConversation,
  patchWhatsAppConversation,
  refreshWhatsAppStatus,
  setWhatsAppFilter,
  setWhatsAppQuery,
  setWhatsAppSort,
  retryWhatsAppChatMessage,
  selectWhatsAppConversation,
  sendWhatsAppChatMessage,
  setWhatsAppStatus,
  startWhatsAppChatEvents,
  stopWhatsAppChatEvents,
  whatsappChats,
  whatsappShell,
} from '../lib/whatsapp'
import { formatDateTime } from '../lib/workflow'
import { locale, t } from '../i18n'
import { errorText, toast } from '../stores/ui'
import { askLulux } from '../lib/ask-lulux'
import {
  createWhatsAppQuickReply,
  deleteWhatsAppQuickReply,
  listWhatsAppQuickReplies,
  type WhatsAppConversationSort,
  type WhatsAppQuickReply,
} from '../api/whatsapp'

/**
 * WhatsApp 入口页：会话 / 渠道两个分段。
 * 会话页接真实服务端会话/消息接口与 SSE；渠道页接真实绑定通道与出口代理。
 * 整台服务只关联一个 WhatsApp 账号，由第一个开始绑定的成员占用；其他成员操作时服务端返回 WHATSAPP_ACCOUNT_BUSY。
 * 页面不生成占位二维码、不推断「已连接」，所有绑定与消息事实都来自服务端。
 */
const route = useRoute()
const router = useRouter()

type WhatsAppTab = 'chats' | 'channels'

const tab = computed<WhatsAppTab>(() => (route.meta.whatsappTab === 'channels' ? 'channels' : 'chats'))

const status = computed(() => whatsappShell.status)
const engine = computed(() => status.value?.engine ?? null)
const account = computed(() => status.value?.account ?? null)
const qr = computed(() => status.value?.qr ?? null)
const pairing = computed(() => status.value?.pairing ?? null)
const reconnect = computed(() => status.value?.reconnect ?? null)
const risk = computed(() => status.value?.risk ?? { accepted: false, acceptedAt: null, expiresAt: null, version: null })
const limits = computed(() => status.value?.limits ?? { linkedDevices: 4, phoneOfflineDays: 14, deviceIdleDays: 30 })
const phase = computed(() => status.value?.phase ?? 'unbound')
const error = computed(() => status.value?.error ?? null)
const qrAvailable = computed(() => Boolean(engine.value?.installed && engine.value.qrAvailable))
const riskAccepted = computed(() => risk.value.accepted)
const accountPhone = computed(() => (account.value ? plusPhone(account.value.phone) : ''))
const linkedSlots = computed(() => (account.value && phase.value !== 'reauth' ? 1 : 0))

/* ───────────────────────── 会话页（真实数据，契约 §12.3） ───────────────────────── */

const chats = whatsappChats
/** 筛选在服务端做（全部 / 未读 / 待回复 / 已归档 / 标签）；列表就是当前筛选的结果 */
const shownConversations = computed(() => chats.conversations)
const FILTERS: WhatsAppConversationFilter[] = ['all', 'unread', 'pending', 'archived']
const LIST_TABS: WhatsAppConversationFilter[] = ['all', 'unread', 'pending']
/** 列表第四个页签：最常用的会话标签 */
const topTag = computed(() => chats.counts.tags[0]?.tag ?? null)
function onSortChange(event: Event): void {
  void setWhatsAppSort((event.target as HTMLSelectElement).value as WhatsAppConversationSort).catch(() => undefined)
}

/** 会话标签配色：待办类（待…/急）用提醒色，其余按名字固定落到一种色，同名标签颜色一致 */
function tagTone(tag: string): 'warn' | 'info' | 'neutral' {
  if (/^待|急|urgent|todo/i.test(tag)) return 'warn'
  let h = 0
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 2 ? 'info' : 'neutral'
}

/** 左栏搜索：名称 / 号码 / 客户公司（停顿 300ms 再查） */
const searchText = ref(chats.q)
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchText, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void setWhatsAppQuery(value.trim()).catch(() => undefined), 300)
})

/** 快捷回复：每个人自己的常用回复，点一下填入输入框 */
const quickReplies = ref<WhatsAppQuickReply[]>([])
const quickFormOpen = ref(false)
const quickTitle = ref('')
const quickBody = ref('')
const quickBusy = ref(false)
const quickMenuOpen = ref(false)
async function loadQuickReplies(): Promise<void> {
  try {
    quickReplies.value = (await listWhatsAppQuickReplies()).items
  } catch {
    quickReplies.value = []
  }
}
function insertQuickReply(item: WhatsAppQuickReply): void {
  quickMenuOpen.value = false
  if (!activeConversation.value) {
    toast.error(t('whatsapp.quickNeedConversation'))
    return
  }
  composer.value = composer.value.trim() ? `${composer.value.trimEnd()}\n${item.body}` : item.body
  void nextTick(() => composerEl.value?.focus())
}
async function saveQuickReply(): Promise<void> {
  const title = quickTitle.value.trim()
  const body = quickBody.value.trim()
  if (!title || !body || quickBusy.value) return
  quickBusy.value = true
  try {
    const created = await createWhatsAppQuickReply({ title, body })
    quickReplies.value = [...quickReplies.value, created]
    quickTitle.value = ''
    quickBody.value = ''
    quickFormOpen.value = false
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    quickBusy.value = false
  }
}
async function removeQuickReply(item: WhatsAppQuickReply): Promise<void> {
  try {
    await deleteWhatsAppQuickReply(item.id)
    quickReplies.value = quickReplies.value.filter((x) => x.id !== item.id)
  } catch (error) {
    toast.error(errorText(error))
  }
}


/** 会话头部「更多」菜单（置顶 / 归档） */
const moreOpen = ref(false)
function closeMenus(event: MouseEvent): void {
  const el = event.target as HTMLElement | null
  if (!el?.closest('[data-menu]')) {
    moreOpen.value = false
    quickMenuOpen.value = false
  }
}
onMounted(() => document.addEventListener('click', closeMenus))
onBeforeUnmount(() => document.removeEventListener('click', closeMenus))

/** 问 LULUX：带上客户上下文，让 Agent 看这个会话并给下一步建议 */
function askAboutConversation(): void {
  const c = activeConversation.value
  if (!c) return
  void askLulux(router, {
    customerId: c.customerId ?? undefined,
    prompt: t('whatsapp.askLuluxPrompt', [activeName.value, c.phone]),
  })
}
function filterLabel(filter: WhatsAppConversationFilter): string {
  return t(`whatsapp.filter_${filter}`)
}
function chooseFilter(filter: WhatsAppConversationFilter, tag: string | null = null): void {
  if (chats.filter === filter && chats.tag === tag) return
  void setWhatsAppFilter(filter, tag).catch(() => undefined)
}
const listTitle = computed(() => (chats.tag ? chats.tag : filterLabel(chats.filter)))
const listMeta = computed(() =>
  chats.filter === 'all' && !chats.tag
    ? t('whatsapp.chatListMeta', [chats.counts.all, whatsappShell.unread])
    : t('whatsapp.chatListCount', [chats.total]),
)

/** 列表按最近消息分组：置顶 / 今天 / 昨天 / 更早 */
function groupKey(c: WhatsAppConversation): string {
  if (c.pinnedAt) return 'pinned'
  const at = c.lastMessageAt ?? c.createdAt
  if (sameDay(at, now.value)) return 'today'
  const y = new Date(now.value)
  y.setDate(y.getDate() - 1)
  return sameDay(at, y.getTime()) ? 'yesterday' : 'earlier'
}
function showGroup(index: number): boolean {
  const cur = shownConversations.value[index]
  if (!cur) return false
  const prev = shownConversations.value[index - 1]
  return !prev || groupKey(prev) !== groupKey(cur)
}

/** 右侧客户档案开关（记住上次选择） */
const PROFILE_KEY = 'lulux.whatsapp.profileOpen'
const profileOpen = ref(localStorage.getItem(PROFILE_KEY) !== '0')
function toggleProfile(): void {
  profileOpen.value = !profileOpen.value
  localStorage.setItem(PROFILE_KEY, profileOpen.value ? '1' : '0')
}

/** 档案里关联 / 取消关联客户后，同步列表与会话头部显示的公司名 */
function onProfileLinked(customerName: string | null): void {
  const c = activeConversation.value
  if (c) mergeWhatsAppConversation({ ...c, customerName })
}

/** 会话整理：置顶 / 归档 */
const organizing = ref(false)
async function organize(patch: { archived?: boolean; pinned?: boolean }): Promise<void> {
  const c = activeConversation.value
  if (!c || organizing.value) return
  organizing.value = true
  try {
    await patchWhatsAppConversation(c.id, patch)
    if (patch.archived !== undefined) toast.success(t(patch.archived ? 'whatsapp.archivedToast' : 'whatsapp.unarchivedToast'))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    organizing.value = false
  }
}

/** 收到的消息译成中文（本机翻译引擎，结果只在本页缓存，不改原文） */
const INCOMING_KEY = 'lulux.whatsapp.translateIncoming'
const incomingOn = ref(localStorage.getItem(INCOMING_KEY) === '1')
const incomingText = ref<Record<string, string>>({})
const incomingFailed = ref(false)
const INCOMING_LANG_KEY = 'lulux.whatsapp.incomingLang'
const incomingLang = ref<WhatsAppTranslatorTarget | ''>((localStorage.getItem(INCOMING_LANG_KEY) as WhatsAppTranslatorTarget | null) ?? '')
const incomingTarget = computed<WhatsAppTranslatorTarget>(() => incomingLang.value || (locale.value === 'en' ? 'en' : 'zh-Hans'))
function onIncomingLangChange(event: Event): void {
  incomingLang.value = (event.target as HTMLSelectElement).value as WhatsAppTranslatorTarget
  localStorage.setItem(INCOMING_LANG_KEY, incomingLang.value)
}
let incomingRun = 0
async function translateIncoming(): Promise<void> {
  if (!incomingOn.value) return
  const run = ++incomingRun
  const todo = chats.messages
    .filter((m) => m.direction === 'in' && m.body.trim() && !(m.id in incomingText.value))
    .slice(-20)
  for (const m of todo) {
    try {
      const r = await translateWhatsAppText({ text: m.body, targetLang: incomingTarget.value, conversationId: m.conversationId })
      if (run !== incomingRun) return
      incomingText.value = { ...incomingText.value, [m.id]: r.text.trim() === m.body.trim() ? '' : r.text }
      incomingFailed.value = false
    } catch {
      if (run === incomingRun) incomingFailed.value = true
      return
    }
  }
}
function toggleIncoming(): void {
  incomingOn.value = !incomingOn.value
  localStorage.setItem(INCOMING_KEY, incomingOn.value ? '1' : '0')
  if (incomingOn.value) void translateIncoming()
}
watch(
  () => [chats.messages.length, chats.activeId, incomingTarget.value],
  () => void translateIncoming(),
)
watch(incomingTarget, () => {
  incomingText.value = {}
})
const isChatConnected = computed(() => status.value?.connection === 'connected')
const activeConversation = computed<WhatsAppConversation | null>(
  () => whatsappChats.conversations.find((item) => item.id === whatsappChats.activeId) ?? null,
)
const activeName = computed(() =>
  activeConversation.value
    ? activeConversation.value.displayName?.trim() || plusPhone(activeConversation.value.phone)
    : '',
)

const streamEl = ref<HTMLElement | null>(null)
const composerEl = ref<HTMLTextAreaElement | null>(null)
const newPhoneEl = ref<HTMLInputElement | null>(null)

const composer = ref('')
const sending = ref(false)
const composerError = ref('')
const retryingId = ref('')

const newOpen = ref(false)
const newPhone = ref('')
const newName = ref('')
const newBusy = ref(false)
const newError = ref('')

let chatBootstrapped = false

const canSend = computed(
  () =>
    Boolean(activeConversation.value) &&
    isChatConnected.value &&
    composer.value.trim().length > 0 &&
    !sending.value,
)

const composerPlaceholder = computed(() => {
  if (!isChatConnected.value) return t('whatsapp.chatComposerOffline')
  if (!activeConversation.value) return t('whatsapp.chatComposerNoTarget')
  return t('whatsapp.chatComposerPlaceholder')
})

/* ───────────────────────── 输入翻译（运行时引擎，契约 §12.7） ───────────────────────── */

const LANG_KEYS: Record<WhatsAppTranslatorTarget, string> = {
  en: 'whatsapp.langEn',
  'zh-Hans': 'whatsapp.langZhHans',
  'zh-Hant': 'whatsapp.langZhHant',
  ja: 'whatsapp.langJa',
  ko: 'whatsapp.langKo',
  ru: 'whatsapp.langRu',
  es: 'whatsapp.langEs',
  pt: 'whatsapp.langPt',
  fr: 'whatsapp.langFr',
  de: 'whatsapp.langDe',
  ar: 'whatsapp.langAr',
  th: 'whatsapp.langTh',
  vi: 'whatsapp.langVi',
  id: 'whatsapp.langId',
  auto: 'whatsapp.langAuto',
}

interface TranslationFailure {
  code: string
  message: string
  installHint: string
}

const TRANSLATE_KEY = 'lulux.whatsapp.translateCompose'
const TRANSLATE_TARGET_KEY = 'lulux.whatsapp.translateTarget'
const translateOn = ref(localStorage.getItem(TRANSLATE_KEY) === '1')
/** 默认目标语言固定为 en；auto 只能由用户显式选择。 */
const translateTarget = ref<WhatsAppTranslatorTarget>(
  (WHATSAPP_TRANSLATOR_TARGETS as readonly string[]).includes(localStorage.getItem(TRANSLATE_TARGET_KEY) ?? '')
    ? (localStorage.getItem(TRANSLATE_TARGET_KEY) as WhatsAppTranslatorTarget)
    : 'en',
)
/** 小框：用母语输入，译文自动填进主输入框（主输入框才是要发出去的内容） */
const translateSource = ref('')
const translationFilled = ref(false)
let translateTimer: ReturnType<typeof setTimeout> | null = null
watch(translateSource, () => {
  translationFilled.value = false
  if (translateTimer) clearTimeout(translateTimer)
  if (!translateOn.value) return
  translateTimer = setTimeout(() => void runTranslation(), 600)
})
function onTranslateSourceKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (translateTimer) clearTimeout(translateTimer)
  void runTranslation()
}
const sourceLangLabel = computed(() => t(locale.value === 'en' ? 'whatsapp.langEn' : 'whatsapp.langZhHans'))
const translation = ref<WhatsAppTranslation | null>(null)
const translationSource = ref('')
const translationFailure = ref<TranslationFailure | null>(null)
const translating = ref(false)
let translationSeq = 0

const targetOptions = computed(() => {
  void locale.value
  return WHATSAPP_TRANSLATOR_TARGETS.map((value) => ({
    value,
    label: t(LANG_KEYS[value]),
  }))
})

const translatorMissing = computed(
  () => translationFailure.value?.code === 'TRANSLATOR_NOT_INSTALLED',
)
const translationTitle = computed(() =>
  translatorMissing.value ? t('whatsapp.translateMissingTitle') : t('whatsapp.translateFailedTitle'),
)

function languageName(code: string): string {
  if (code in LANG_KEYS) return t(LANG_KEYS[code as WhatsAppTranslatorTarget])
  return code
}

function resetTranslationPreview(): void {
  translationSeq += 1
  translation.value = null
  translationSource.value = ''
  translationFailure.value = null
  translating.value = false
}

async function runTranslation(): Promise<void> {
  const text = translateSource.value.trim()
  if (!text) {
    translation.value = null
    translationSource.value = ''
    translationFailure.value = null
    return
  }
  const seq = ++translationSeq
  translating.value = true
  translationFailure.value = null
  try {
    const result = await translateWhatsAppText(
      {
        text,
        targetLang: translateTarget.value,
        conversationId: whatsappChats.activeId ?? undefined,
      },
      false,
    )
    if (seq !== translationSeq) return
    translation.value = result
    translationSource.value = text
    // 译文直接填进主输入框，发出去的就是主输入框里的内容
    composer.value = result.text
    translationFilled.value = true
  } catch (cause) {
    if (seq !== translationSeq) return
    translation.value = null
    const details =
      cause instanceof ApiError && cause.details && typeof cause.details === 'object'
        ? (cause.details as { installHint?: unknown })
        : null
    translationFailure.value = {
      code: cause instanceof ApiError ? cause.code : 'TRANSLATION_FAILED',
      message: errorText(cause),
      installHint:
        typeof details?.installHint === 'string' && details.installHint
          ? details.installHint
          : 'docs/WHATSAPP-TRANSLATOR.md',
    }
  } finally {
    if (seq === translationSeq) translating.value = false
  }
}

function toggleTranslation(): void {
  translateOn.value = !translateOn.value
  localStorage.setItem(TRANSLATE_KEY, translateOn.value ? '1' : '0')
  resetTranslationPreview()
  translationFilled.value = false
  composerError.value = ''
  if (translateOn.value && translateSource.value.trim()) void runTranslation()
}

function onTranslateTargetChange(): void {
  localStorage.setItem(TRANSLATE_TARGET_KEY, translateTarget.value)
  resetTranslationPreview()
  translationFilled.value = false
  if (translateOn.value && translateSource.value.trim()) void runTranslation()
}

/* ───────────────────────── 会话与消息操作 ───────────────────────── */

function conversationName(conversation: WhatsAppConversation): string {
  return conversation.displayName?.trim() || plusPhone(conversation.phone)
}

function conversationPreview(conversation: WhatsAppConversation): string {
  const text = conversation.lastMessagePreview?.trim()
  if (!text) return t('whatsapp.chatNoPreview')
  return `${conversation.lastMessageDirection === 'out' ? t('whatsapp.chatYouPrefix') : ''}${text}`
}


function sameDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function dayKey(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dateLabel(value: number): string {
  if (sameDay(value, now.value)) return t('whatsapp.chatToday')
  const yesterday = new Date(now.value)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(value, yesterday.getTime())) return t('whatsapp.chatYesterday')
  return new Intl.DateTimeFormat(locale.value === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function clockTime(value: number): string {
  return new Intl.DateTimeFormat(locale.value === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

function listTime(value: number | null): string {
  if (!value || value <= 0) return ''
  const date = new Date(value)
  if (sameDay(value, now.value)) return clockTime(value)
  const yesterday = new Date(now.value)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(value, yesterday.getTime())) return t('whatsapp.chatYesterday')
  const sameYear = date.getFullYear() === new Date(now.value).getFullYear()
  return new Intl.DateTimeFormat(locale.value === 'en' ? 'en-US' : 'zh-CN', {
    ...(sameYear ? {} : { year: '2-digit' as const }),
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

function showDay(index: number): boolean {
  const current = whatsappChats.messages[index]
  if (!current) return false
  const previous = whatsappChats.messages[index - 1]
  return !previous || dayKey(previous.createdAt) !== dayKey(current.createdAt)
}

function outboundStatus(message: WhatsAppMessage): string {
  if (message.direction !== 'out') return ''
  if (message.status === 'sending') return t('whatsapp.chatStatusSending')
  if (message.status === 'failed') return t('whatsapp.chatStatusFailed')
  if (message.status === 'sent') return t('whatsapp.chatStatusSent')
  return ''
}

function scrollToBottom(smooth = true): void {
  void nextTick(() => {
    const element = streamEl.value
    if (!element) return
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    } else {
      element.scrollTop = element.scrollHeight
    }
  })
}

async function ensureChatData(): Promise<void> {
  if (tab.value !== 'chats') return
  startWhatsAppChatEvents()
  if (!whatsappShell.loaded || chatBootstrapped) return
  chatBootstrapped = true
  void loadQuickReplies()
  if (whatsappChats.conversationsLoaded || whatsappChats.conversationsLoading) {
    // 绑定成功时用户可能还在渠道页，入站事件发生后才切到会话页。
    // 事件无法回放，列表又是空的，这里补拉一次，避免会话页一直显示空列表。
    if (whatsappChats.conversations.length === 0) {
      await loadWhatsAppConversations().catch(() => undefined)
    }
    return
  }
  await loadWhatsAppConversations().catch(() => undefined)
}

async function reloadConversations(): Promise<void> {
  chatBootstrapped = true
  await loadWhatsAppConversations().catch(() => undefined)
}

async function loadMoreConversations(): Promise<void> {
  if (whatsappChats.conversationsLoading) return
  try {
    await loadWhatsAppConversations({ append: true })
  } catch (cause) {
    toast.error(errorText(cause))
  }
}

async function openConversation(conversationId: string): Promise<void> {
  if (!conversationId || whatsappChats.activeId === conversationId) return
  resetTranslationPreview()
  composerError.value = ''
  await selectWhatsAppConversation(conversationId).catch(() => undefined)
  scrollToBottom(false)
  if (translateOn.value && composer.value.trim()) void runTranslation()
}

async function loadEarlierMessages(): Promise<void> {
  const conversationId = whatsappChats.activeId
  const before = whatsappChats.messagesCursor
  if (!conversationId || !before || whatsappChats.olderLoading) return
  const element = streamEl.value
  const previousHeight = element?.scrollHeight ?? 0
  await loadWhatsAppMessages(conversationId, { before }).catch(() => undefined)
  await nextTick()
  if (element) element.scrollTop += element.scrollHeight - previousHeight
}

async function reloadMessages(): Promise<void> {
  const conversationId = whatsappChats.activeId
  if (!conversationId) return
  await loadWhatsAppMessages(conversationId).catch(() => undefined)
  scrollToBottom(false)
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void sendCurrent()
}

async function sendCurrent(): Promise<void> {
  if (!canSend.value) return
  const text = composer.value.trim()
  composer.value = ''
  composerError.value = ''
  sending.value = true
  if (translationSource.value) {
    resetTranslationPreview()
    translateSource.value = ''
    translationFilled.value = false
  }
  try {
    await sendWhatsAppChatMessage(text)
    scrollToBottom()
  } catch (cause) {
    composerError.value = errorText(cause)
    toast.error(composerError.value)
    const details =
      cause instanceof ApiError && cause.details && typeof cause.details === 'object'
        ? (cause.details as { messageId?: unknown })
        : null
    // 服务端已落库为 failed 时由气泡上的「重试」继续；没有落库才把原文放回输入框。
    if (typeof details?.messageId !== 'string') composer.value = text
  } finally {
    sending.value = false
    void nextTick(() => composerEl.value?.focus())
  }
}

async function retryMessage(message: WhatsAppMessage): Promise<void> {
  if (retryingId.value) return
  retryingId.value = message.id
  try {
    await retryWhatsAppChatMessage(message.id)
    scrollToBottom()
  } catch (cause) {
    toast.error(errorText(cause))
  } finally {
    retryingId.value = ''
  }
}

function openNewConversation(prefill: { phone?: string; name?: string } = {}): void {
  newOpen.value = true
  newPhone.value = prefill.phone ?? ''
  newName.value = prefill.name ?? ''
  newError.value = ''
  void nextTick(() => newPhoneEl.value?.focus())
}

function closeNewConversation(): void {
  if (!newBusy.value) newOpen.value = false
}

async function submitNewConversation(): Promise<void> {
  if (newBusy.value) return
  const phone = newPhone.value.trim().replace(/[\s-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    newError.value = t('whatsapp.chatNewInvalidPhone')
    return
  }
  newBusy.value = true
  newError.value = ''
  try {
    const conversation = await createWhatsAppConversation(
      phone,
      newName.value.trim() || undefined,
    )
    mergeWhatsAppConversation(conversation)
    newOpen.value = false
    await openConversation(conversation.id)
  } catch (cause) {
    newError.value = errorText(cause)
    toast.error(newError.value)
  } finally {
    newBusy.value = false
  }
}

watch(
  () => whatsappChats.messages.length,
  () => {
    if (!whatsappChats.olderLoading) scrollToBottom()
  },
)

watch(composer, (value) => {
  // 手动改了主输入框里的译文：不再显示「已填入」
  if (translationFilled.value && translation.value && value !== translation.value.text) translationFilled.value = false
})

const now = ref(Date.now())
let timer: number | null = null

const qrExpired = computed(() => Boolean(qr.value && (qr.value.expired || qr.value.expiresAt <= now.value)))
const pairingExpired = computed(() =>
  Boolean(pairing.value && (pairing.value.expired || pairing.value.expiresAt <= now.value)),
)
const qrRemaining = computed(() => clock(qr.value ? (qr.value.expiresAt - now.value) / 1000 : 0))
const pairingRemaining = computed(() =>
  clock(pairing.value ? (pairing.value.expiresAt - now.value) / 1000 : 0),
)
const reconnectNext = computed(() =>
  reconnect.value ? Math.max(0, Math.ceil((reconnect.value.nextAt - now.value) / 1000)) : 0,
)

const hasPairingError = computed(() => Boolean(error.value?.code.startsWith('PAIRING_')))
const showConnected = computed(() => Boolean(account.value && phase.value === 'connected'))
const showReauth = computed(
  () =>
    Boolean(account.value) &&
    (phase.value === 'reauth' || error.value?.code === 'AUTH_LOGGED_OUT' || error.value?.code === 'AUTH_REPLACED'),
)
const showReconnecting = computed(
  () =>
    Boolean(account.value) &&
    !showReauth.value &&
    (phase.value === 'reconnecting' || phase.value === 'connecting'),
)
const showDisconnected = computed(
  () => Boolean(account.value) && !showReauth.value && error.value?.code === 'DISCONNECTED',
)
const showFailed = computed(
  () =>
    Boolean(account.value) &&
    !showReauth.value &&
    !showDisconnected.value &&
    !showReconnecting.value &&
    phase.value === 'failed' &&
    !hasPairingError.value,
)
const showBinding = computed(() => !account.value || hasPairingError.value)

const forceBind = ref(false)
const showBindingSection = computed(
  () => Boolean(engine.value?.installed) && (forceBind.value || showBinding.value),
)
const showEngineMissing = computed(() => engine.value?.installed === false)

const stateTone = computed(() => {
  if (showConnected.value) return 'good'
  if (showReauth.value || showDisconnected.value || showFailed.value) return 'bad'
  if (phase.value === 'waiting_qr' && qrExpired.value) return 'bad'
  if (phase.value === 'waiting_pairing' && pairingExpired.value) return 'bad'
  if (
    showReconnecting.value ||
    phase.value === 'connecting' ||
    phase.value === 'waiting_qr' ||
    phase.value === 'waiting_pairing' ||
    (phase.value === 'failed' && !hasPairingError.value)
  ) {
    return 'warn'
  }
  return ''
})

const stateLabel = computed(() => {
  if (!status.value) return t('whatsapp.loadingStatus')
  if (showConnected.value) return t('whatsapp.stateConnected')
  if (showReauth.value) return t('whatsapp.stateLoggedOut')
  if (phase.value === 'reconnecting') return t('whatsapp.stateReconnecting')
  if (phase.value === 'connecting') return t('whatsapp.stateConnecting')
  if (phase.value === 'waiting_qr') {
    return qrExpired.value ? t('whatsapp.stateQrExpired') : t('whatsapp.stateWaitingQr')
  }
  if (phase.value === 'waiting_pairing') {
    return pairingExpired.value ? t('whatsapp.statePairingExpired') : t('whatsapp.stateWaitingPairing')
  }
  if (showDisconnected.value) return t('whatsapp.stateDisconnected')
  if (phase.value === 'failed') {
    return hasPairingError.value ? t('whatsapp.statePairingFailed') : t('whatsapp.stateFailed')
  }
  if (phase.value === 'reauth') return t('whatsapp.stateLoggedOut')
  return t('whatsapp.stateUnbound')
})

const activeConnection = computed(() => {
  const current = status.value
  if (!current) return null
  if (current.connection === 'disconnected' && current.phase === 'unbound') return null
  return current.connection
})

const currentModeLabel = computed(() => {
  if (phase.value === 'reauth') return t('whatsapp.modeExpired')
  if (status.value?.mode === 'qr') return t('whatsapp.modeQr')
  if (status.value?.mode === 'pairing') return t('whatsapp.modePairing')
  return t('whatsapp.modeUnknown')
})

const STATE_STRIP = [
  { key: 'connected', label: 'appRail.whatsappStateConnected', desc: 'whatsapp.stateConnectedDesc' },
  { key: 'connecting', label: 'appRail.whatsappStateConnecting', desc: 'whatsapp.stateConnectingDesc' },
  { key: 'disconnected', label: 'appRail.whatsappStateDisconnected', desc: 'whatsapp.stateDisconnectedDesc' },
  { key: 'reauth', label: 'appRail.whatsappStateReauth', desc: 'whatsapp.stateReauthDesc' },
] as const

const ERROR_KEYS: Record<string, string> = {
  ENGINE_NOT_INSTALLED: 'whatsapp.errEngineMissing',
  ENGINE_LOAD_FAILED: 'whatsapp.errEngineLoad',
  ENGINE_START_FAILED: 'whatsapp.errEngineStart',
  ENGINE_QR_RENDER_FAILED: 'whatsapp.errQrRender',
  QR_REFRESH_FAILED: 'whatsapp.errQrRefresh',
  PAIRING_INVALID_PHONE: 'whatsapp.errInvalidPhone',
  PAIRING_CODE_EXPIRED: 'whatsapp.errPairingExpired',
  PAIRING_CODE_INVALID: 'whatsapp.errPairingInvalid',
  PAIRING_FAILED: 'whatsapp.errPairingFailed',
  PAIRING_REJECTED: 'whatsapp.errPairingRejected',
  AUTH_LOGGED_OUT: 'whatsapp.errAuthLoggedOut',
  AUTH_REPLACED: 'whatsapp.errAuthReplaced',
  RECONNECT_EXHAUSTED: 'whatsapp.errReconnectExhausted',
  RISK_ACCEPTANCE_REQUIRED: 'whatsapp.errRiskRequired',
  WHATSAPP_ACCOUNT_BUSY: 'whatsapp.errBusy',
  WHATSAPP_NOT_LINKED: 'whatsapp.errNotLinked',
  DISCONNECTED: 'whatsapp.errDisconnected',
  CONFIRMATION_REQUIRED: 'whatsapp.errConfirmation',
}

const engineErrorText = computed(() =>
  engine.value?.error ? errorMessage(engine.value.error.code, engine.value.error.message) : '',
)
const stateErrorText = computed(() =>
  error.value ? errorMessage(error.value.code, error.value.message) : t('whatsapp.failedBody'),
)
const failedTitle = computed(() =>
  error.value?.code === 'RECONNECT_EXHAUSTED' ? t('whatsapp.exhaustedTitle') : t('whatsapp.failedTitle'),
)
const riskAcceptedDate = computed(() =>
  risk.value.acceptedAt ? formatDateTime(risk.value.acceptedAt) : t('whatsapp.modeUnknown'),
)
const pairingGrouped = computed(() => groupCode(pairing.value?.code ?? ''))
const pairingPhone = computed(() => (pairing.value ? plusPhone(pairing.value.phone) : ''))

const region = ref('CN')
const national = ref('')
const countryOptions = computed(() => COUNTRY_CODES.map((item) => ({
  region: item.region,
  label: `${regionName(item.region)} ${item.code}`,
})))
const dialCode = computed(
  () => COUNTRY_CODES.find((item) => item.region === region.value)?.code ?? '+86',
)
const e164 = computed(() => `${dialCode.value}${national.value.replace(/\D/g, '')}`)
const phoneValid = computed(() => /^\+[1-9]\d{7,14}$/.test(e164.value))

const riskCheck1 = ref(false)
const riskCheck2 = ref(false)
const riskReady = computed(() => riskCheck1.value && riskCheck2.value)

const selectedMode = ref<WhatsAppLinkMode>('qr')
const forcedPairing = ref(false)
const qrUnavailableForced = computed(() => Boolean(engine.value?.installed && !engine.value.qrAvailable))

const busy = ref('')
const actionError = ref('')
const logoutOpen = ref(false)
const logoutChecked = ref(false)
const autoStarted = ref(false)

const gateEl = ref<HTMLElement | null>(null)
const phoneInput = ref<HTMLInputElement | null>(null)
const tosEl = ref<HTMLElement | null>(null)

const canUseAction = (name: string): boolean => busy.value === '' || busy.value === name

function isWhatsAppStatus(value: unknown): value is WhatsAppStatus {
  return Boolean(value && typeof value === 'object' && 'phase' in value && 'engine' in value)
}

async function run<T>(action: string, fn: () => Promise<T>): Promise<T | null> {
  if (busy.value) return null
  busy.value = action
  actionError.value = ''
  try {
    const result = await fn()
    if (isWhatsAppStatus(result)) setWhatsAppStatus(result)
    return result
  } catch (cause) {
    const message = errorText(cause)
    actionError.value = message
    toast.error(message)
    return null
  } finally {
    if (busy.value === action) busy.value = ''
  }
}

function errorMessage(code: string, detail?: string): string {
  const key = ERROR_KEYS[code]
  if (key) return t(key)
  return detail || t('whatsapp.errUnknown')
}

function plusPhone(phone: string): string {
  const value = String(phone ?? '').trim()
  if (!value) return ''
  return value.startsWith('+') ? value : `+${value}`
}

function groupCode(code: string): string {
  const clean = code.replace(/[^A-Za-z0-9]/g, '')
  return clean.replace(/(.{4})/g, '$1 ').trim()
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function timeText(value: number | null | undefined): string {
  return value && value > 0 ? formatDateTime(value) : t('whatsapp.deviceUnknown')
}

function safeScroll(element: HTMLElement | null, block: ScrollLogicalPosition = 'center'): void {
  element?.scrollIntoView?.({ behavior: 'smooth', block })
}

function scrollToGate(): void {
  safeScroll(gateEl.value)
}

function scrollToTos(): void {
  safeScroll(tosEl.value, 'start')
}

function focusPhoneForm(): void {
  void nextTick(() => phoneInput.value?.focus())
}

function onNationalInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const digits = target.value.replace(/\D/g, '').slice(0, 15)
  national.value = digits
  target.value = digits
  actionError.value = ''
}

function selectMode(mode: WhatsAppLinkMode): void {
  if (mode === 'qr' && !qrAvailable.value) return
  selectedMode.value = mode
  actionError.value = ''
  if (mode === 'pairing') {
    focusPhoneForm()
    return
  }
  if (!riskAccepted.value || account.value) return
  const current = status.value
  if (current?.mode === 'qr' && current.qr) return
  void run('start', () => startWhatsAppLink('qr'))
}

async function acceptRisk(): Promise<void> {
  if (!riskReady.value || busy.value) return
  const result = await run('accept', acceptWhatsAppRisk)
  if (!result) return
  if (selectedMode.value === 'qr' && qrAvailable.value && !result.account && result.phase === 'unbound') {
    await run('start', () => startWhatsAppLink('qr'))
    return
  }
  if (selectedMode.value === 'pairing') focusPhoneForm()
}

async function refreshQrAction(): Promise<void> {
  if (!riskAccepted.value) {
    toast.info(t('whatsapp.riskFirst'))
    scrollToGate()
    return
  }
  await run('refresh', refreshWhatsAppQr)
}

async function generatePairingCode(): Promise<void> {
  if (!riskAccepted.value) {
    toast.info(t('whatsapp.riskFirst'))
    scrollToGate()
    return
  }
  if (!phoneValid.value) {
    actionError.value = t('whatsapp.phoneInvalid')
    focusPhoneForm()
    return
  }
  const phone = e164.value
  const current = status.value
  const reuse = Boolean(
    current?.mode === 'pairing' && !current.account && current.phase !== 'unbound',
  )
  await run('pair', () =>
    reuse ? requestWhatsAppPairingCode(phone) : startWhatsAppLink('pairing', phone),
  )
}

async function copyPairingCode(): Promise<void> {
  if (!pairing.value?.code || pairingExpired.value) return
  const ok = await copyText(pairing.value.code)
  if (ok) toast.success(t('whatsapp.codeCopied'))
  else toast.error(t('whatsapp.codeCopyFailed'))
}

async function refreshStatusAction(): Promise<void> {
  await run('status', () => refreshWhatsAppStatus(false))
}

async function retryLoad(): Promise<void> {
  const result = await run('status', () => refreshWhatsAppStatus(false))
  if (result) await maybeAutoStart()
}

async function disconnect(): Promise<void> {
  const result = await run('stop', stopWhatsAppLink)
  if (result) toast.success(t('whatsapp.disconnectDone'))
}

function openLogout(): void {
  logoutChecked.value = false
  logoutOpen.value = true
}

function closeLogout(): void {
  if (busy.value !== 'logout') logoutOpen.value = false
}

async function confirmLogout(): Promise<void> {
  if (!logoutChecked.value || busy.value) return
  const result = await run('logout', logoutWhatsApp)
  if (!result) return
  logoutOpen.value = false
  toast.success(t('whatsapp.logoutDone'))
}

async function beginRelink(mode: WhatsAppLinkMode): Promise<void> {
  if (mode === 'qr' && !qrAvailable.value) return
  forceBind.value = true
  selectedMode.value = mode
  actionError.value = ''
  if (!riskAccepted.value) {
    await nextTick()
    scrollToGate()
    return
  }
  if (mode === 'pairing') {
    focusPhoneForm()
    return
  }
  await run('relink', () => startWhatsAppLink('qr'))
}

async function reconnectNow(): Promise<void> {
  const current = status.value
  const mode = current?.mode ?? selectedMode.value
  if (mode === 'pairing') {
    const phone = current?.pairing?.phone ?? account.value?.phone
    if (phone) {
      await run('retry', () => startWhatsAppLink('pairing', plusPhone(phone)))
      return
    }
    selectedMode.value = 'pairing'
    forceBind.value = true
    focusPhoneForm()
    return
  }
  selectedMode.value = 'qr'
  await run('retry', () => startWhatsAppLink('qr'))
}

async function maybeAutoStart(): Promise<void> {
  if (autoStarted.value || tab.value !== 'channels') return
  const current = status.value
  if (!whatsappShell.loaded || !current) return
  if (!current.risk.accepted || !current.engine.installed || !current.engine.qrAvailable) {
    autoStarted.value = true
    return
  }
  if (current.account || current.phase !== 'unbound' || selectedMode.value !== 'qr') {
    autoStarted.value = true
    return
  }
  autoStarted.value = true
  await run('start', () => startWhatsAppLink('qr'))
}

watch(
  () => status.value?.mode,
  (mode) => {
    if (mode && !forcedPairing.value) selectedMode.value = mode
  },
  { immediate: true },
)

watch(
  qrUnavailableForced,
  (unavailable) => {
    if (unavailable) {
      if (selectedMode.value === 'qr') {
        selectedMode.value = 'pairing'
        forcedPairing.value = true
      }
      return
    }
    if (forcedPairing.value) {
      selectedMode.value = 'qr'
      forcedPairing.value = false
    }
  },
  { immediate: true },
)

watch(
  () => status.value?.phase,
  (value) => {
    if (value === 'connected') {
      forceBind.value = false
      logoutOpen.value = false
    }
  },
)

watch(tab, (value) => {
  if (value === 'channels') void nextTick().then(maybeAutoStart)
  else void ensureChatData()
})

watch(
  () => whatsappShell.loaded,
  () => {
    void maybeAutoStart()
    void ensureChatData()
  },
)

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
  if (!whatsappShell.loaded) void refreshWhatsAppStatus().catch(() => undefined)
  void nextTick().then(maybeAutoStart)
  void ensureChatData().then(openFromQuery)
})

/** 从客户档案跳来：?conversation= 直接打开会话；?phone=&name= 预填“新会话”，由用户确认后再建 */
async function openFromQuery(): Promise<void> {
  if (tab.value !== 'chats') return
  const conversation = typeof route.query.conversation === 'string' ? route.query.conversation : ''
  const phone = typeof route.query.phone === 'string' ? route.query.phone : ''
  if (conversation) await openConversation(conversation)
  else if (phone) openNewConversation({ phone, name: typeof route.query.name === 'string' ? route.query.name : '' })
}

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  stopWhatsAppChatEvents()
})

const COUNTRY_CODES = [
  { region: 'CN', code: '+86' },
  { region: 'HK', code: '+852' },
  { region: 'TW', code: '+886' },
  { region: 'MO', code: '+853' },
  { region: 'US', code: '+1' },
  { region: 'CA', code: '+1' },
  { region: 'GB', code: '+44' },
  { region: 'AU', code: '+61' },
  { region: 'JP', code: '+81' },
  { region: 'KR', code: '+82' },
  { region: 'SG', code: '+65' },
  { region: 'MY', code: '+60' },
  { region: 'TH', code: '+66' },
  { region: 'VN', code: '+84' },
  { region: 'ID', code: '+62' },
  { region: 'PH', code: '+63' },
  { region: 'IN', code: '+91' },
  { region: 'AE', code: '+971' },
  { region: 'DE', code: '+49' },
  { region: 'FR', code: '+33' },
  { region: 'NL', code: '+31' },
  { region: 'ES', code: '+34' },
  { region: 'IT', code: '+39' },
  { region: 'BR', code: '+55' },
  { region: 'MX', code: '+52' },
  { region: 'RU', code: '+7' },
  { region: 'ZA', code: '+27' },
] as const

function regionName(regionCode: string): string {
  const build = (Intl as unknown as {
    DisplayNames?: new (
      locales: string[],
      options: { type: string },
    ) => { of: (code: string) => string | undefined }
  }).DisplayNames
  if (!build) return regionCode
  try {
    return new build([locale.value], { type: 'region' }).of(regionCode) ?? regionCode
  } catch {
    return regionCode
  }
}

/* ── LULUX 起草的回复：存在会话上（只存草稿，不会自动发出），使用或丢弃后清掉 ── */
const draft = computed(() => activeConversation.value?.draft ?? null)
const draftBusy = ref(false)
async function clearDraft(): Promise<boolean> {
  const c = activeConversation.value
  if (!c || draftBusy.value) return false
  draftBusy.value = true
  try {
    await patchWhatsAppConversation(c.id, { draft: null })
    return true
  } catch (error) {
    toast.error(errorText(error))
    return false
  } finally {
    draftBusy.value = false
  }
}
/** 使用并编辑：草稿放进主输入框（不自动发送），会话上的草稿随即清掉 */
async function useDraft(): Promise<void> {
  const text = draft.value?.text
  if (!text) return
  if (!(await clearDraft())) return
  composer.value = composer.value.trim() ? `${composer.value.trimEnd()}\n${text}` : text
  void nextTick(() => composerEl.value?.focus())
}
async function dismissDraft(): Promise<void> {
  if (await clearDraft()) toast.success(t('whatsapp.draftDismissed'))
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('appRail.whatsapp')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('appRail.whatsapp') }}</h2>
        <button
          v-if="tab === 'chats' && status"
          type="button"
          class="link wa-side-new"
          data-testid="whatsapp-side-new"
          @click="openNewConversation()"
        >
          {{ $t('whatsapp.sideNewConversation') }}
        </button>
        <span v-else class="wa-pill" :class="stateTone" data-testid="whatsapp-side-state">{{ stateLabel }}</span>
      </div>
      <nav class="wa-seg" :aria-label="$t('appRail.whatsapp')">
        <RouterLink
          v-for="item in WHATSAPP_TABS"
          :key="item.to"
          :to="item.to"
          class="wa-seg-btn"
          active-class=""
          exact-active-class=""
          :class="{ on: tabActive(item, route.path) }"
          :aria-current="tabActive(item, route.path) ? 'page' : undefined"
          :data-testid="item.testid"
          >{{ $t(item.label) }}</RouterLink
        >
      </nav>
      <label v-if="tab === 'chats'" class="wa-side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input
          v-model="searchText"
          type="search"
          :placeholder="$t('whatsapp.sideSearch')"
          :aria-label="$t('whatsapp.sideSearch')"
          data-testid="whatsapp-search"
        />
      </label>
      <div class="side-body">
        <p v-if="tab !== 'chats'" class="side-label">
          {{ $t('whatsapp.channelsSideNote') }}
        </p>

        <template v-if="tab === 'channels'">
          <div class="wa-side-account">
            <span class="wa-dot" :class="whatsappShell.connection" aria-hidden="true"></span>
            <div class="wa-side-account-text">
              <strong>{{ stateLabel }}</strong>
              <span v-if="account" class="wa-side-phone">{{ accountPhone }}</span>
              <span v-else class="wa-side-sub">{{ $t('whatsapp.stateStripHint') }}</span>
            </div>
          </div>

          <div class="wa-side-block">
            <p class="side-label">{{ $t('whatsapp.sideRisk') }}</p>
            <p class="wa-side-risk" :class="{ 'is-good': riskAccepted }">
              {{ riskAccepted ? $t('whatsapp.sideRiskAcceptedYes') : $t('whatsapp.sideRiskAcceptedNo') }}
            </p>
          </div>

          <div class="wa-side-block">
            <p class="side-label">{{ $t('whatsapp.sideEngine') }}</p>
            <p class="wa-side-risk">
              <template v-if="engine?.installed">{{ engine.version || '—' }} · {{ engine.id }}</template>
              <template v-else>{{ $t('whatsapp.sideEngineMissing') }}</template>
            </p>
          </div>

          <div class="wa-side-meta">
            <div>
              <span>{{ $t('whatsapp.sideMethod') }}</span>
              <span>{{ currentModeLabel }}</span>
            </div>
            <div>
              <span>{{ $t('whatsapp.limitsTitle') }}</span>
              <span>{{ $t('whatsapp.limitsCount', [linkedSlots]) }}</span>
            </div>
          </div>
        </template>

        <template v-else>
          <nav v-if="tab === 'chats'" class="wa-side-filters" :aria-label="$t('whatsapp.chatListTitle')">
            <button
              v-for="f in FILTERS"
              :key="f"
              type="button"
              class="nav-row"
              :class="{ on: chats.filter === f && !chats.tag }"
              :aria-pressed="chats.filter === f && !chats.tag"
              :data-testid="`whatsapp-filter-${f}`"
              @click="chooseFilter(f)"
            >
              {{ filterLabel(f) }}<span class="count">{{ chats.counts[f] }}</span>
            </button>
          </nav>
          <template v-if="tab === 'chats' && chats.counts.tags.length">
            <p class="wa-side-label">{{ $t('whatsapp.sideTags') }}</p>
            <nav class="wa-side-filters" :aria-label="$t('whatsapp.sideTags')">
              <button
                v-for="item in chats.counts.tags"
                :key="item.tag"
                type="button"
                class="nav-row"
                :class="{ on: chats.tag === item.tag }"
                :aria-pressed="chats.tag === item.tag"
                data-testid="whatsapp-filter-tag"
                @click="chooseFilter('all', item.tag)"
              >
                {{ item.tag }}<span class="count">{{ item.count }}</span>
              </button>
            </nav>
          </template>
          <p class="wa-side-label">{{ $t('whatsapp.sideChannel') }}</p>
          <RouterLink to="/whatsapp/channels" class="wa-side-channel" data-testid="whatsapp-side-channel">
            <span class="wa-side-channel-top">
              <strong>{{ account ? accountPhone : stateLabel }}</strong>
              <span class="wa-dot" :class="whatsappShell.connection" aria-hidden="true"></span>
            </span>
            <span class="wa-side-sub" :class="whatsappShell.connection">
              <template v-if="account">{{ $t('whatsapp.linkModeDevice') }} · {{ stateLabel }}</template>
              <template v-else>{{ $t('whatsapp.stateStripHint') }}</template>
            </span>
          </RouterLink>
          <template v-if="tab === 'chats'">
            <div class="wa-side-label wa-side-label-row">
              <span>{{ $t('whatsapp.sideQuick') }}</span>
              <button type="button" class="link" data-testid="whatsapp-quick-add" @click="quickFormOpen = !quickFormOpen">
                {{ quickFormOpen ? $t('whatsapp.chatNewCancel') : $t('whatsapp.quickAdd') }}
              </button>
            </div>
            <form v-if="quickFormOpen" class="wa-quick-form" data-testid="whatsapp-quick-form" @submit.prevent="saveQuickReply">
              <input v-model="quickTitle" class="input sm" maxlength="30" :placeholder="$t('whatsapp.quickTitlePlaceholder')" data-testid="whatsapp-quick-title" />
              <textarea v-model="quickBody" class="input sm" rows="3" maxlength="2000" :placeholder="$t('whatsapp.quickBodyPlaceholder')" data-testid="whatsapp-quick-body"></textarea>
              <button type="submit" class="kbtn sm primary" :disabled="quickBusy || !quickTitle.trim() || !quickBody.trim()">{{ $t('whatsapp.quickSave') }}</button>
            </form>
            <nav class="wa-side-filters" :aria-label="$t('whatsapp.sideQuick')">
              <div v-for="item in quickReplies" :key="item.id" class="wa-quick-row">
                <button type="button" class="nav-row" :title="item.body" data-testid="whatsapp-quick-item" @click="insertQuickReply(item)">
                  {{ item.title }}
                </button>
                <button type="button" class="wa-quick-x" :aria-label="$t('whatsapp.quickDelete', [item.title])" @click="removeQuickReply(item)">×</button>
              </div>
              <p v-if="!quickReplies.length && !quickFormOpen" class="wa-side-sub wa-side-empty">{{ $t('whatsapp.quickEmpty') }}</p>
            </nav>
          </template>
          <p v-if="tab === 'chats' && whatsappChats.conversationsError" class="wa-side-sub">
            {{ $t('whatsapp.chatListErrorTitle') }}
          </p>
        </template>
      </div>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('appRail.whatsapp')" :search="false" :ask="tab !== 'chats'" />
    <div class="doc" :class="{ 'doc-chat': Boolean(status) && tab === 'chats' }">
      <div v-if="!status" class="card wa-loading" data-testid="whatsapp-loading">
        <template v-if="!whatsappShell.loadError">
          <span class="spinner" aria-hidden="true"></span>
          <p>{{ $t('whatsapp.loadingStatus') }}</p>
        </template>
        <template v-else>
          <h2>{{ $t('whatsapp.loadFailed') }}</h2>
          <p>{{ $t('whatsapp.loadFailedBody') }}</p>
          <code class="wa-code-chip">{{ whatsappShell.loadError }}</code>
          <button class="kbtn" :disabled="busy === 'status'" @click="retryLoad">
            {{ busy === 'status' ? $t('whatsapp.loadingStatus') : $t('whatsapp.retry') }}
          </button>
        </template>
      </div>

      <div v-else-if="tab === 'chats'" class="wa-chat" :class="{ 'with-profile': activeConversation && profileOpen }" data-testid="whatsapp-chats">
        <aside class="wa-chat-list" :aria-label="$t('whatsapp.chatConversationListLabel')">
          <div class="wa-chat-list-head">
            <h2 class="wa-chat-list-title">{{ listTitle }}</h2>
            <span class="wa-chat-list-meta" data-testid="whatsapp-chat-list-meta">{{ listMeta }}</span>
            <select
              class="wa-sort"
              :value="chats.sort"
              :aria-label="$t('whatsapp.sortLabel')"
              data-testid="whatsapp-sort"
              @change="onSortChange"
            >
              <option value="recent">{{ $t('whatsapp.sortRecent') }}</option>
              <option value="unread">{{ $t('whatsapp.sortUnread') }}</option>
            </select>
          </div>
          <div class="wa-list-tabs" role="tablist" :aria-label="$t('whatsapp.chatListTitle')">
            <button
              v-for="f in LIST_TABS"
              :key="f"
              type="button"
              role="tab"
              :aria-selected="chats.filter === f && !chats.tag"
              :class="{ on: chats.filter === f && !chats.tag }"
              :data-testid="`whatsapp-tab-${f}`"
              @click="chooseFilter(f)"
            >
              {{ filterLabel(f) }}<span v-if="f !== 'all' && chats.counts[f]" class="wa-list-tab-n">{{ chats.counts[f] }}</span>
            </button>
            <button
              v-if="topTag"
              type="button"
              role="tab"
              :aria-selected="chats.tag === topTag"
              :class="{ on: chats.tag === topTag }"
              data-testid="whatsapp-tab-tag"
              @click="chooseFilter('all', topTag)"
            >
              {{ topTag }}
            </button>
          </div>

          <form
            v-if="newOpen"
            class="wa-new"
            data-testid="whatsapp-new-form"
            @submit.prevent="submitNewConversation"
          >
            <h3>{{ $t('whatsapp.chatNewTitle') }}</h3>
            <p>{{ $t('whatsapp.chatNewSub') }}</p>
            <label class="wa-new-field">
              <span>{{ $t('whatsapp.chatNewPhone') }}</span>
              <input
                ref="newPhoneEl"
                v-model="newPhone"
                class="input"
                type="tel"
                inputmode="tel"
                :placeholder="$t('whatsapp.chatNewPhonePlaceholder')"
                data-testid="whatsapp-new-phone"
                :disabled="newBusy"
              />
            </label>
            <label class="wa-new-field">
              <span>{{ $t('whatsapp.chatNewName') }}</span>
              <input
                v-model="newName"
                class="input"
                :placeholder="$t('whatsapp.chatNewNamePlaceholder')"
                data-testid="whatsapp-new-name"
                maxlength="80"
                :disabled="newBusy"
              />
            </label>
            <p v-if="newError" class="wa-new-error" data-testid="whatsapp-new-error">{{ newError }}</p>
            <div class="wa-new-actions">
              <button type="button" class="kbtn sm" :disabled="newBusy" @click="closeNewConversation">
                {{ $t('whatsapp.chatNewCancel') }}
              </button>
              <button type="submit" class="kbtn sm primary" :disabled="newBusy" data-testid="whatsapp-new-submit">
                {{ newBusy ? $t('whatsapp.chatNewSubmitting') : $t('whatsapp.chatNewSubmit') }}
              </button>
            </div>
          </form>

          <div class="wa-conv-scroll">
            <StateBlock
              v-if="!chats.conversationsLoaded && chats.conversationsLoading"
              state="loading"
              :title="$t('whatsapp.chatListLoading')"
              compact
            />
            <StateBlock
              v-else-if="chats.conversationsError && !chats.conversations.length"
              state="error"
              :title="$t('whatsapp.chatListErrorTitle')"
              :message="chats.conversationsError"
              compact
              data-testid="whatsapp-conversation-error"
              @retry="reloadConversations"
            />
            <StateBlock
              v-else-if="!chats.conversations.length"
              state="empty"
              :title="$t('whatsapp.chatListEmpty')"
              :message="$t('whatsapp.chatListEmptyBody')"
              compact
              data-testid="whatsapp-conversation-empty"
            >
              <button type="button" class="kbtn sm" @click="openNewConversation()">
                {{ $t('whatsapp.chatNewConversation') }}
              </button>
            </StateBlock>
            <template v-else>
              <template v-for="(conversation, index) in shownConversations" :key="conversation.id">
              <p v-if="showGroup(index)" class="wa-group">{{ $t(`whatsapp.group_${groupKey(conversation)}`) }}</p>
              <button
                type="button"
                class="wa-conv"
                :class="{ on: chats.activeId === conversation.id }"
                data-testid="whatsapp-conversation"
                :data-conversation-id="conversation.id"
                @click="openConversation(conversation.id)"
              >
                <span class="wa-conv-body">
                  <span class="wa-conv-top">
                    <svg v-if="conversation.pinnedAt" class="wa-pin" viewBox="0 0 24 24" :aria-label="$t('whatsapp.pinned')"><path d="M9 3h6l-1 6 3 3H7l3-3-1-6ZM12 12v9" /></svg>
                    <strong>{{ conversationName(conversation) }}</strong>
                    <span v-if="conversation.customerName" class="wa-conv-company">{{ conversation.customerName }}</span>
                    <time>{{ listTime(conversation.lastMessageAt ?? conversation.createdAt) }}</time>
                  </span>
                  <span class="wa-conv-preview">{{ conversationPreview(conversation) }}</span>
                  <span v-if="conversation.tags.length || conversation.unreadCount > 0" class="wa-conv-bottom">
                    <span class="wa-conv-tags">
                      <span v-for="tag in conversation.tags.slice(0, 3)" :key="tag" class="wa-conv-tag" :data-tone="tagTone(tag)">{{ tag }}</span>
                    </span>
                    <span
                      v-if="conversation.unreadCount > 0"
                      class="wa-unread"
                      data-testid="whatsapp-unread"
                    >{{ conversation.unreadCount > 99 ? '99+' : conversation.unreadCount }}</span>
                  </span>
                </span>
              </button>
              </template>
              <p v-if="!shownConversations.length" class="wa-side-sub wa-filter-empty" data-testid="whatsapp-filter-empty">
                {{ $t('whatsapp.filterEmpty') }}
              </p>
              <button
                v-if="chats.hasMore"
                type="button"
                class="wa-conv-more"
                data-testid="whatsapp-load-more-conversations"
                :disabled="chats.conversationsLoading"
                @click="loadMoreConversations"
              >
                {{ chats.conversationsLoading ? $t('whatsapp.chatLoadingEarlier') : $t('whatsapp.chatListLoadMore') }}
              </button>
            </template>
          </div>
          <p v-if="chats.conversationsLoaded" class="wa-list-foot" data-testid="whatsapp-list-foot">
            {{ $t('whatsapp.listFoot', [chats.total, shownConversations.length]) }}
          </p>
        </aside>

        <section class="wa-chat-pane">
          <template v-if="activeConversation">
            <header class="wa-chat-head">
              <div class="wa-chat-head-name">
                <strong data-testid="whatsapp-active-name">{{ activeName }}<template v-if="activeConversation.customerName"> · {{ activeConversation.customerName }}</template></strong>
                <span class="wa-chat-head-sub" data-testid="whatsapp-chat-state">
                  <span class="wa-dot" :class="whatsappShell.connection" aria-hidden="true"></span>
                  {{ $t('whatsapp.headSub', [plusPhone(activeConversation.phone), stateLabel]) }}
                </span>
              </div>
              <div class="wa-head-tools">
                <button
                  type="button"
                  class="wa-head-btn"
                  :class="{ on: incomingOn }"
                  :aria-pressed="incomingOn"
                  data-testid="whatsapp-incoming-translate"
                  :title="$t('whatsapp.incomingTranslateHint')"
                  @click="toggleIncoming"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.5 6.6M11 5c-.8 3.6-3.2 6.3-6.5 7.6M13 21l4-9 4 9M14.4 18h5.2" /></svg>
                  {{ $t('whatsapp.incomingPill', [languageName(incomingTarget)]) }}
                </button>
                <button type="button" class="wa-head-btn plain" data-testid="whatsapp-ask-lulux" @click="askAboutConversation">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" /></svg>
                  LULUX
                </button>
                <button
                  type="button"
                  class="wa-head-icon"
                  :class="{ on: profileOpen }"
                  :aria-pressed="profileOpen"
                  :aria-label="$t('whatsapp.profileToggle')"
                  :title="$t('whatsapp.profileToggle')"
                  data-testid="whatsapp-profile-toggle"
                  @click="toggleProfile"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2" /><path d="M14.5 4.5v15" /></svg>
                </button>
                <div class="wa-menu-wrap" data-menu>
                  <button
                    type="button"
                    class="wa-head-icon"
                    :aria-label="$t('whatsapp.more')"
                    :aria-expanded="moreOpen"
                    data-testid="whatsapp-more"
                    @click="moreOpen = !moreOpen"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></svg>
                  </button>
                  <div v-if="moreOpen" class="wa-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      :disabled="organizing"
                      data-testid="whatsapp-pin"
                      @click="moreOpen = false; organize({ pinned: !activeConversation.pinnedAt })"
                    >
                      {{ activeConversation.pinnedAt ? $t('whatsapp.unpin') : $t('whatsapp.pin') }}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      :disabled="organizing"
                      data-testid="whatsapp-archive"
                      @click="moreOpen = false; organize({ archived: !activeConversation.archivedAt })"
                    >
                      {{ activeConversation.archivedAt ? $t('whatsapp.unarchive') : $t('whatsapp.archive') }}
                    </button>
                  </div>
                </div>
              </div>
            </header>

            <div
              v-if="!isChatConnected"
              class="wa-chat-offline"
              data-testid="whatsapp-chat-disconnected"
              role="status"
            >
              <div>
                <strong>{{ $t('whatsapp.chatDisconnectedTitle') }}</strong>
                <p>{{ $t('whatsapp.chatDisconnectedBody') }}</p>
              </div>
              <RouterLink class="kbtn sm" to="/whatsapp/channels">
                {{ $t('whatsapp.chatGoChannels') }}
              </RouterLink>
            </div>

            <div
              ref="streamEl"
              class="wa-stream"
              data-testid="whatsapp-message-stream"
              role="log"
              aria-live="polite"
            >
              <StateBlock
                v-if="chats.messagesLoading && !chats.messages.length"
                state="loading"
                :title="$t('whatsapp.chatMessagesLoading')"
              />
              <StateBlock
                v-else-if="chats.messagesError && !chats.messages.length"
                state="error"
                :title="$t('whatsapp.chatMessagesErrorTitle')"
                :message="chats.messagesError"
                data-testid="whatsapp-messages-error"
                @retry="reloadMessages"
              />
              <template v-else>
                <button
                  v-if="chats.messagesHasMore"
                  type="button"
                  class="wa-stream-more"
                  data-testid="whatsapp-load-earlier"
                  :disabled="chats.olderLoading"
                  @click="loadEarlierMessages"
                >
                  {{ chats.olderLoading ? $t('whatsapp.chatLoadingEarlier') : $t('whatsapp.chatLoadEarlier') }}
                </button>
                <StateBlock
                  v-if="!chats.messages.length && chats.messagesLoaded"
                  state="empty"
                  :title="$t('whatsapp.chatMessagesEmpty')"
                  compact
                />
                <template v-for="(message, index) in chats.messages" :key="message.id">
                  <div v-if="showDay(index)" class="wa-day"><span>{{ dateLabel(message.createdAt) }}</span></div>
                  <div
                    class="wa-msg"
                    :class="[message.direction, message.status]"
                    data-testid="whatsapp-message"
                    :data-direction="message.direction"
                    :data-status="message.status"
                  >
                    <div class="wa-bubble">
                      <p class="wa-bubble-body" dir="auto">{{ message.body }}</p>
                      <p
                        v-if="incomingOn && message.direction === 'in' && incomingText[message.id]"
                        class="wa-bubble-trans"
                        dir="auto"
                        data-testid="whatsapp-incoming-translation"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.5 6.6M11 5c-.8 3.6-3.2 6.3-6.5 7.6M13 21l4-9 4 9M14.4 18h5.2" /></svg>
                        <span>{{ incomingText[message.id] }}</span>
                      </p>
                      <p v-if="message.status === 'failed' && message.failureReason" class="wa-bubble-error">
                        {{ $t('whatsapp.chatFailureReason', [message.failureReason]) }}
                      </p>
                      <button
                        v-if="message.direction === 'out' && message.status === 'failed'"
                        type="button"
                        class="wa-bubble-retry"
                        data-testid="whatsapp-retry-message"
                        :disabled="Boolean(retryingId)"
                        @click="retryMessage(message)"
                      >
                        {{ retryingId === message.id ? $t('whatsapp.chatRetrying') : $t('whatsapp.chatRetrySend') }}
                      </button>
                    </div>
                    <div class="wa-bubble-meta">
                      <span v-if="outboundStatus(message)" class="wa-bubble-status">
                        {{ outboundStatus(message) }}
                      </span>
                      <time>{{ clockTime(message.createdAt) }}</time>
                    </div>
                  </div>
                </template>
              </template>
            </div>

            <div v-if="draft" class="wa-suggest" data-testid="whatsapp-draft">
              <div class="wa-suggest-head">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" /></svg>
                <span class="wa-suggest-title">{{ $t('whatsapp.draftTitle') }}</span>
                <span class="wa-suggest-badge">{{ $t('whatsapp.draftPending') }}</span>
                <span class="wa-suggest-src">{{ $t('whatsapp.draftAt', [listTime(draft.createdAt)]) }}</span>
              </div>
              <p class="wa-suggest-text" dir="auto">{{ draft.text }}</p>
              <div class="wa-suggest-actions">
                <button type="button" class="kbtn sm primary" :disabled="draftBusy" data-testid="whatsapp-draft-use" @click="useDraft">{{ $t('whatsapp.draftUse') }}</button>
                <button type="button" class="kbtn sm ghost" :disabled="draftBusy" data-testid="whatsapp-draft-dismiss" @click="dismissDraft">{{ $t('whatsapp.draftDismiss') }}</button>
              </div>
            </div>

            <div class="wa-composer">
              <div class="wa-compose-box" :class="{ disabled: !isChatConnected }">
                <textarea
                  ref="composerEl"
                  v-model="composer"
                  class="wa-composer-input"
                  :placeholder="composerPlaceholder"
                  :aria-label="$t('whatsapp.chatMessageInputLabel')"
                  data-testid="whatsapp-composer"
                  rows="2"
                  :disabled="!activeConversation || sending"
                  @keydown="onComposerKeydown"
                ></textarea>
                <div v-if="translateOn" class="wa-trans-line" data-testid="whatsapp-translation">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.5 6.6M11 5c-.8 3.6-3.2 6.3-6.5 7.6M13 21l4-9 4 9M14.4 18h5.2" /></svg>
                  <input
                    v-model="translateSource"
                    class="wa-trans-input"
                    :placeholder="$t('whatsapp.translateSourcePlaceholder', [sourceLangLabel])"
                    :aria-label="$t('whatsapp.translateSourcePlaceholder', [sourceLangLabel])"
                    data-testid="whatsapp-translate-source"
                    @keydown="onTranslateSourceKeydown"
                  />
                  <span class="wa-trans-arrow" aria-hidden="true">→</span>
                  <select
                    v-model="translateTarget"
                    class="wa-trans-target"
                    :aria-label="$t('whatsapp.translateTarget')"
                    data-testid="whatsapp-translate-target"
                    @change="onTranslateTargetChange"
                  >
                    <option v-for="option in targetOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                  <span v-if="translating" class="wa-trans-state" role="status">{{ $t('whatsapp.translateLoading') }}</span>
                  <span v-else-if="translationFilled" class="wa-trans-state ok" data-testid="whatsapp-translation-filled">✓ {{ $t('whatsapp.translateFilled') }}</span>
                </div>
                <div
                  v-if="translateOn && translationFailure"
                  class="wa-translate-error"
                  data-testid="whatsapp-translation-error"
                  :data-code="translationFailure.code"
                >
                  <strong>{{ translationTitle }}</strong>
                  <p>{{ translatorMissing ? $t('whatsapp.translateMissingBody') : translationFailure.message }}</p>
                  <p class="wa-translate-code">{{ $t('whatsapp.translateMissingCode', [translationFailure.code]) }}</p>
                  <code class="wa-code-chip">{{ translationFailure.installHint }}</code>
                </div>
                <div class="wa-compose-bar">
                  <div class="wa-menu-wrap" data-menu>
                    <button
                      type="button"
                      class="wa-tool"
                      :aria-label="$t('whatsapp.sideQuick')"
                      :title="$t('whatsapp.sideQuick')"
                      :aria-expanded="quickMenuOpen"
                      data-testid="whatsapp-quick-menu"
                      @click="quickMenuOpen = !quickMenuOpen"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" /></svg>
                    </button>
                    <div v-if="quickMenuOpen" class="wa-menu up" role="menu">
                      <button v-for="item in quickReplies" :key="item.id" type="button" role="menuitem" :title="item.body" @click="insertQuickReply(item)">
                        {{ item.title }}
                      </button>
                      <p v-if="!quickReplies.length" class="wa-menu-empty">{{ $t('whatsapp.quickEmpty') }}</p>
                    </div>
                  </div>
                  <label class="wa-trans-pill" :class="{ on: translateOn }">
                    <input
                      type="checkbox"
                      class="sr-only"
                      :checked="translateOn"
                      data-testid="whatsapp-translate-toggle"
                      @change="toggleTranslation"
                    />
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.5 6.6M11 5c-.8 3.6-3.2 6.3-6.5 7.6M13 21l4-9 4 9M14.4 18h5.2" /></svg>
                    {{ sourceLangLabel }} → {{ languageName(translateTarget) }}
                  </label>
                  <span class="wa-compose-hint">
                    {{ !isChatConnected ? $t('whatsapp.chatComposerOffline') : translateOn ? $t('whatsapp.composeHintTranslate') : $t('whatsapp.composeHint') }}
                  </span>
                  <button
                    type="button"
                    class="wa-send"
                    :disabled="!canSend"
                    :aria-label="sending ? $t('whatsapp.chatSending') : $t('whatsapp.chatSend')"
                    :title="sending ? $t('whatsapp.chatSending') : $t('whatsapp.chatSend')"
                    data-testid="whatsapp-send"
                    @click="sendCurrent"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                  </button>
                </div>
              </div>
              <p v-if="composerError" class="wa-composer-error" data-testid="whatsapp-send-error">
                {{ composerError }}
              </p>
            </div>
          </template>

          <div v-else class="wa-chat-blank">
            <StateBlock
              v-if="!isChatConnected && !chats.conversations.length"
              state="empty"
              :title="$t('whatsapp.chatDisconnectedTitle')"
              :message="$t('whatsapp.chatDisconnectedBody')"
              data-testid="whatsapp-chat-blank-offline"
            >
              <RouterLink class="kbtn sm" to="/whatsapp/channels">
                {{ $t('whatsapp.chatGoChannels') }}
              </RouterLink>
            </StateBlock>
            <StateBlock
              v-else
              state="empty"
              :title="chats.conversations.length ? $t('whatsapp.chatSelectTitle') : $t('whatsapp.chatNoConversationTitle')"
              :message="chats.conversations.length ? $t('whatsapp.chatSelectBody') : $t('whatsapp.chatNoConversationBody')"
              data-testid="whatsapp-chat-blank"
            >
              <button
                v-if="!chats.conversations.length"
                type="button"
                class="kbtn sm"
                @click="openNewConversation()"
              >
                {{ $t('whatsapp.chatNewConversation') }}
              </button>
            </StateBlock>
          </div>
        </section>
        <WhatsAppProfilePanel
          v-if="activeConversation && profileOpen"
          :conversation="activeConversation"
          :link-mode="$t('whatsapp.linkModeDevice')"
          @close="toggleProfile"
          @linked="onProfileLinked"
        >
          <section class="wa-trans-settings" data-testid="whatsapp-translation-settings">
            <h4>{{ $t('whatsapp.transSettings') }}</h4>
            <label>
              <span>{{ $t('whatsapp.transIncoming') }}</span>
              <select :value="incomingTarget" data-testid="whatsapp-incoming-lang" @change="onIncomingLangChange">
                <option v-for="option in targetOptions.filter((o) => o.value !== 'auto')" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label>
              <span>{{ $t('whatsapp.transOutgoing') }}</span>
              <select v-model="translateTarget" data-testid="whatsapp-outgoing-lang" @change="onTranslateTargetChange">
                <option v-for="option in targetOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="wa-trans-switch">
              <span>{{ $t('whatsapp.transAuto') }}</span>
              <input type="checkbox" role="switch" :checked="incomingOn" data-testid="whatsapp-incoming-auto" @change="toggleIncoming" />
            </label>
          </section>
        </WhatsAppProfilePanel>
      </div>

      <div v-else class="wa-channels" data-testid="whatsapp-channels">
        <div class="wa-head">
          <div>
            <h1 class="wa-title">{{ $t('whatsapp.bindTitle') }}</h1>
            <p class="wa-sub">{{ $t('whatsapp.bindSub') }}</p>
          </div>
          <div class="wa-head-state">
            <span v-if="account" class="wa-head-phone">{{ accountPhone }}</span>
            <span class="wa-pill" :class="stateTone" data-testid="whatsapp-state-pill">{{ stateLabel }}</span>
          </div>
        </div>

        <div v-if="whatsappShell.loadError" class="wa-alert warn" data-testid="whatsapp-stale">
          <span>{{ $t('whatsapp.staleState') }}</span>
          <code class="wa-code-chip">{{ whatsappShell.loadError }}</code>
        </div>
        <details class="card wa-proxy" data-testid="whatsapp-proxy">
          <summary>{{ $t('waProxy.localTitle') }}</summary>
          <WhatsAppProxyForm />
        </details>

        <div class="wa-layout">
          <div class="wa-primary">
            <section v-if="showEngineMissing" class="card wa-engine" data-testid="whatsapp-engine-missing">
              <div class="wa-engine-icon" aria-hidden="true">!</div>
              <div class="wa-engine-copy">
                <h2>{{ engine?.error?.code === 'ENGINE_LOAD_FAILED' ? $t('whatsapp.engineLoadFailedTitle') : $t('whatsapp.engineMissingTitle') }}</h2>
                <p>
                  {{ engine?.error?.code === 'ENGINE_LOAD_FAILED' ? $t('whatsapp.engineLoadFailedBody') : $t('whatsapp.engineMissingBody') }}
                </p>
                <div v-if="engine?.error" class="wa-error-row">
                  <span>{{ $t('whatsapp.engineMissingCode') }}</span>
                  <code class="wa-code-chip">{{ engine.error.code }}</code>
                  <span>{{ engineErrorText }}</span>
                </div>
                <div class="wa-engine-doc">
                  <span>{{ $t('whatsapp.engineInstallDoc') }}</span>
                  <code>docs/WHATSAPP-ENGINE.md</code>
                </div>
                <div class="wa-actions">
                  <button class="kbtn sm" :disabled="busy === 'status'" @click="refreshStatusAction">
                    {{ busy === 'status' ? $t('whatsapp.loadingStatus') : $t('whatsapp.refreshStatus') }}
                  </button>
                </div>
              </div>
            </section>

            <template v-if="engine?.installed">
              <section v-if="showConnected" class="wa-state-panel good" data-testid="whatsapp-connected">
                <div class="wa-state-tile" aria-hidden="true">✓</div>
                <div class="wa-state-copy">
                  <div class="wa-state-heading">
                    <h2>{{ $t('whatsapp.connectedTitle') }}</h2>
                    <span class="wa-pill good">{{ $t('whatsapp.stateConnected') }}</span>
                  </div>
                  <p>{{ $t('whatsapp.connectedSub') }}</p>
                  <dl class="wa-facts">
                    <div>
                      <dt>{{ $t('whatsapp.factMethod') }}</dt>
                      <dd>{{ currentModeLabel }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('whatsapp.factPhone') }}</dt>
                      <dd>{{ accountPhone }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('whatsapp.factDevice') }}</dt>
                      <dd>{{ account?.deviceName || $t('whatsapp.deviceUnknown') }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('whatsapp.factLinkedAt') }}</dt>
                      <dd>{{ timeText(account?.linkedAt) }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('whatsapp.factLastLogin') }}</dt>
                      <dd>{{ timeText(account?.lastLoginAt) }}</dd>
                    </div>
                    <div>
                      <dt>{{ $t('whatsapp.factLastActivity') }}</dt>
                      <dd>{{ timeText(account?.lastActivityAt) }}</dd>
                    </div>
                  </dl>
                  <p class="wa-note">{{ $t('whatsapp.heartbeatNote') }}</p>
                  <p class="wa-footnote">{{ $t('whatsapp.bindingOnlyNote') }}</p>
                  <div class="wa-actions">
                    <button
                      class="kbtn sm"
                      :disabled="!canUseAction('status')"
                      data-testid="whatsapp-refresh-status"
                      @click="refreshStatusAction"
                    >
                      {{ busy === 'status' ? $t('whatsapp.refreshingStatus') : $t('whatsapp.refreshStatus') }}
                    </button>
                    <button
                      class="kbtn sm"
                      :disabled="!canUseAction('stop')"
                      data-testid="whatsapp-disconnect"
                      @click="disconnect"
                    >
                      {{ busy === 'stop' ? $t('whatsapp.disconnecting') : $t('whatsapp.disconnect') }}
                    </button>
                    <button
                      class="kbtn sm danger"
                      :disabled="!canUseAction('logout')"
                      data-testid="whatsapp-logout"
                      @click="openLogout"
                    >
                      {{ $t('whatsapp.logout') }}
                    </button>
                  </div>
                </div>
              </section>

              <section v-else-if="showReauth" class="wa-state-panel bad" data-testid="whatsapp-reauth">
                <div class="wa-state-tile" aria-hidden="true">!</div>
                <div class="wa-state-copy">
                  <div class="wa-state-heading">
                    <h2>{{ error?.code === 'AUTH_REPLACED' ? $t('whatsapp.reauthReplacedTitle') : $t('whatsapp.reauthTitle') }}</h2>
                    <span class="wa-pill bad">{{ $t('whatsapp.stateLoggedOut') }}</span>
                  </div>
                  <p>{{ error?.code === 'AUTH_REPLACED' ? $t('whatsapp.reauthReplacedBody') : $t('whatsapp.reauthBody') }}</p>
                  <div v-if="error" class="wa-error-row">
                    <span>{{ $t('whatsapp.errorLabel') }}</span>
                    <code class="wa-code-chip">{{ error.code }}</code>
                    <span>{{ stateErrorText }}</span>
                  </div>
                  <p class="wa-note">{{ $t('whatsapp.reauthHistory') }}</p>
                  <div class="wa-actions">
                    <button
                      v-if="qrAvailable"
                      class="kbtn sm primary"
                      :disabled="!canUseAction('relink')"
                      data-testid="whatsapp-relink-qr"
                      @click="beginRelink('qr')"
                    >
                      {{ $t('whatsapp.relink') }}
                    </button>
                    <button
                      class="kbtn sm"
                      :disabled="Boolean(busy)"
                      data-testid="whatsapp-relink-pairing"
                      @click="beginRelink('pairing')"
                    >
                      {{ $t('whatsapp.relinkPairing') }}
                    </button>
                    <button class="kbtn sm danger" :disabled="!canUseAction('logout')" @click="openLogout">
                      {{ $t('whatsapp.logout') }}
                    </button>
                  </div>
                  <p class="wa-footnote">{{ $t('whatsapp.retryHint') }}</p>
                </div>
              </section>

              <section v-else-if="showReconnecting" class="wa-state-panel warn" data-testid="whatsapp-reconnecting">
                <div class="wa-state-tile" aria-hidden="true"><span class="spinner"></span></div>
                <div class="wa-state-copy">
                  <div class="wa-state-heading">
                    <h2>{{ phase === 'connecting' ? $t('whatsapp.connectingTitle') : $t('whatsapp.reconnectingTitle') }}</h2>
                    <span class="wa-pill warn">{{ $t('whatsapp.stateReconnecting') }}</span>
                  </div>
                  <p>{{ phase === 'connecting' ? $t('whatsapp.connectingBody') : $t('whatsapp.reconnectingBody') }}</p>
                  <p v-if="reconnect" class="wa-note">
                    {{ $t('whatsapp.reconnectAttempt', [reconnect.attempt]) }}
                    · {{ $t('whatsapp.reconnectMax', [reconnect.maxAttempts]) }}
                    <template v-if="reconnectNext > 0">
                      · {{ $t('whatsapp.reconnectNext', [reconnectNext]) }}
                    </template>
                  </p>
                  <div class="wa-actions">
                    <button class="kbtn sm primary" :disabled="Boolean(busy)" @click="reconnectNow">
                      {{ busy === 'retry' ? $t('whatsapp.reconnectingAction') : $t('whatsapp.retryNow') }}
                    </button>
                    <button class="kbtn sm danger" :disabled="!canUseAction('logout')" @click="openLogout">
                      {{ $t('whatsapp.logout') }}
                    </button>
                  </div>
                </div>
              </section>

              <section v-else-if="showDisconnected" class="wa-state-panel warn" data-testid="whatsapp-disconnected">
                <div class="wa-state-tile" aria-hidden="true">!</div>
                <div class="wa-state-copy">
                  <div class="wa-state-heading">
                    <h2>{{ $t('whatsapp.disconnectedTitle') }}</h2>
                    <span class="wa-pill warn">{{ $t('whatsapp.stateDisconnected') }}</span>
                  </div>
                  <p>{{ $t('whatsapp.disconnectedBody') }}</p>
                  <div class="wa-actions">
                    <button
                      class="kbtn sm primary"
                      :disabled="Boolean(busy)"
                      data-testid="whatsapp-reconnect-disconnected"
                      @click="reconnectNow"
                    >
                      {{ busy === 'retry' ? $t('whatsapp.reconnectingAction') : $t('whatsapp.reconnect') }}
                    </button>
                    <button class="kbtn sm danger" :disabled="!canUseAction('logout')" @click="openLogout">
                      {{ $t('whatsapp.logout') }}
                    </button>
                  </div>
                  <p class="wa-footnote">{{ $t('whatsapp.retryHint') }}</p>
                </div>
              </section>

              <section v-else-if="showFailed" class="wa-state-panel bad" data-testid="whatsapp-failed">
                <div class="wa-state-tile" aria-hidden="true">!</div>
                <div class="wa-state-copy">
                  <div class="wa-state-heading">
                    <h2>{{ failedTitle }}</h2>
                    <span class="wa-pill bad">{{ $t('whatsapp.stateFailed') }}</span>
                  </div>
                  <p>{{ stateErrorText }}</p>
                  <div v-if="error" class="wa-error-row">
                    <span>{{ $t('whatsapp.errorLabel') }}</span>
                    <code class="wa-code-chip">{{ error.code }}</code>
                  </div>
                  <div class="wa-actions">
                    <button class="kbtn sm primary" :disabled="Boolean(busy)" @click="reconnectNow">
                      {{ busy === 'retry' ? $t('whatsapp.reconnectingAction') : $t('whatsapp.retryNow') }}
                    </button>
                    <button class="kbtn sm danger" :disabled="!canUseAction('logout')" @click="openLogout">
                      {{ $t('whatsapp.logout') }}
                    </button>
                  </div>
                </div>
              </section>

              <section v-if="showBindingSection" class="card wa-main-card" data-testid="whatsapp-binding">
                <div v-if="error && phase === 'failed' && !hasPairingError" class="wa-alert bad" data-testid="whatsapp-binding-error">
                  <strong>{{ failedTitle }}</strong>
                  <span>{{ stateErrorText }}</span>
                  <code class="wa-code-chip">{{ error.code }}</code>
                </div>

                <div v-if="hasPairingError" class="wa-alert bad" data-testid="whatsapp-pairing-error">
                  <strong>{{ $t('whatsapp.phoneFailedTitle') }}</strong>
                  <span>{{ stateErrorText }}</span>
                  <code v-if="error" class="wa-code-chip">{{ error.code }}</code>
                  <button class="link" type="button" @click="focusPhoneForm">{{ $t('whatsapp.phoneRetry') }}</button>
                </div>

                <div v-if="!riskAccepted" ref="gateEl" class="wa-risk-gate" data-testid="whatsapp-risk-gate">
                  <div class="wa-risk-head">
                    <span class="wa-risk-icon" aria-hidden="true">!</span>
                    <div>
                      <h2>{{ $t('whatsapp.riskGateTitle') }}</h2>
                      <p>{{ $t('whatsapp.riskIntro') }}</p>
                    </div>
                  </div>
                  <ul class="wa-risk-list">
                    <li><strong>{{ $t('whatsapp.riskB1Label') }}</strong>{{ $t('whatsapp.riskB1') }}</li>
                    <li><strong>{{ $t('whatsapp.riskB2Label') }}</strong>{{ $t('whatsapp.riskB2') }}</li>
                    <li><strong>{{ $t('whatsapp.riskB3Label') }}</strong>{{ $t('whatsapp.riskB3') }}</li>
                    <li><strong>{{ $t('whatsapp.riskB4Label') }}</strong>{{ $t('whatsapp.riskB4') }}</li>
                    <li><strong>{{ $t('whatsapp.riskB5Label') }}</strong>{{ $t('whatsapp.riskB5') }}</li>
                  </ul>
                  <p class="wa-risk-liability">{{ $t('whatsapp.riskLiability') }}</p>
                  <label class="wa-check">
                    <input v-model="riskCheck1" type="checkbox" data-testid="whatsapp-risk-check1" />
                    <span>{{ $t('whatsapp.riskCheck1') }}</span>
                  </label>
                  <label class="wa-check">
                    <input v-model="riskCheck2" type="checkbox" data-testid="whatsapp-risk-check2" />
                    <span>{{ $t('whatsapp.riskCheck2') }}</span>
                  </label>
                  <div class="wa-risk-actions">
                    <button
                      class="kbtn primary"
                      :disabled="!riskReady || busy === 'accept'"
                      data-testid="whatsapp-risk-accept"
                      @click="acceptRisk"
                    >
                      {{ busy === 'accept' ? $t('whatsapp.riskAccepting') : $t('whatsapp.riskContinue') }}
                    </button>
                    <button class="link" type="button" @click="scrollToTos">{{ $t('whatsapp.riskFullLink') }}</button>
                    <span class="wa-risk-hint">{{ $t('whatsapp.riskGateHint') }}</span>
                  </div>
                </div>

                <div v-else class="wa-risk-accepted" data-testid="whatsapp-risk-accepted">
                  <span class="wa-stamp"><span aria-hidden="true">✓</span> {{ $t('whatsapp.riskAcceptedStamp', [riskAcceptedDate]) }}</span>
                  <p>{{ $t('whatsapp.riskAcceptedBody') }}</p>
                  <button class="link" type="button" @click="scrollToTos">{{ $t('whatsapp.riskAcceptedLink') }}</button>
                </div>

                <div class="wa-mode-row">
                  <span class="wa-mode-label">{{ $t('whatsapp.modeAria') }}</span>
                  <div class="segmented" role="group" :aria-label="$t('whatsapp.modeAria')">
                    <button
                      type="button"
                      :class="{ on: selectedMode === 'qr' }"
                      :disabled="!qrAvailable"
                      data-testid="whatsapp-mode-qr"
                      @click="selectMode('qr')"
                    >
                      {{ $t('whatsapp.modeQr') }}
                    </button>
                    <button
                      type="button"
                      :class="{ on: selectedMode === 'pairing' }"
                      data-testid="whatsapp-mode-pairing"
                      @click="selectMode('pairing')"
                    >
                      {{ $t('whatsapp.modePairing') }}
                    </button>
                  </div>
                  <span v-if="!qrAvailable" class="wa-mode-note">{{ $t('whatsapp.engineQrMissing') }}</span>
                </div>

                <div v-if="selectedMode === 'qr'" class="wa-qr-pane" data-testid="whatsapp-qr-pane">
                  <div class="wa-qr-col">
                    <div class="wa-qr-frame" :class="{ locked: !riskAccepted, expired: riskAccepted && qrExpired }">
                      <img
                        v-if="qr && riskAccepted"
                        :src="qr.dataUrl"
                        :alt="$t('whatsapp.qrAlt')"
                        data-testid="whatsapp-qr-image"
                      />
                      <div v-if="!riskAccepted" class="wa-qr-cover" data-testid="whatsapp-qr-locked">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.6" />
                          <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        </svg>
                        <strong>{{ $t('whatsapp.qrLockedTitle') }}</strong>
                        <span>{{ $t('whatsapp.qrLockedSub') }}</span>
                      </div>
                      <div v-else-if="qrExpired" class="wa-qr-cover expired-cover" data-testid="whatsapp-qr-expired">
                        <strong>{{ $t('whatsapp.qrExpiredOverlay') }}</strong>
                        <button
                          class="kbtn sm"
                          :disabled="!canUseAction('refresh')"
                          @click="refreshQrAction"
                        >
                          {{ busy === 'refresh' ? $t('whatsapp.qrRefreshing') : $t('whatsapp.qrRefresh') }}
                        </button>
                      </div>
                      <div v-else-if="!qr" class="wa-qr-cover" data-testid="whatsapp-qr-waiting">
                        <span class="spinner" aria-hidden="true"></span>
                        <span>{{ $t('whatsapp.qrWaiting') }}</span>
                      </div>
                    </div>
                    <p class="wa-qr-validity">
                      <template v-if="!riskAccepted">{{ $t('whatsapp.qrFooterLocked') }}</template>
                      <template v-else-if="qr && !qrExpired">{{ $t('whatsapp.qrValidity', [qrRemaining]) }}</template>
                      <template v-else-if="qrExpired">{{ $t('whatsapp.qrExpiredMeta') }}</template>
                      <template v-else>{{ $t('whatsapp.qrWaiting') }}</template>
                    </p>
                    <p v-if="qr && qr.refreshCount > 0" class="wa-qr-refresh-count">
                      {{ $t('whatsapp.qrRefreshCount', [qr.refreshCount]) }}
                    </p>
                  </div>

                  <div class="wa-qr-info">
                    <h2>{{ $t('whatsapp.qrTitle') }}</h2>
                    <p>{{ $t('whatsapp.qrDesc') }}</p>
                    <ol class="wa-steps">
                      <li><span>1</span><div>{{ $t('whatsapp.qrStep1') }}</div></li>
                      <li><span>2</span><div>{{ $t('whatsapp.qrStep2') }}</div></li>
                      <li><span>3</span><div>{{ $t('whatsapp.qrStep3') }}</div></li>
                    </ol>
                    <div class="wa-actions">
                      <button
                        class="kbtn sm"
                        :disabled="!riskAccepted || !canUseAction('refresh') || busy === 'start'"
                        data-testid="whatsapp-qr-refresh"
                        @click="refreshQrAction"
                      >
                        {{ !riskAccepted ? $t('whatsapp.qrRefreshLocked') : busy === 'refresh' ? $t('whatsapp.qrRefreshing') : $t('whatsapp.qrRefresh') }}
                      </button>
                    </div>
                    <p v-if="!qrAvailable" class="wa-note">{{ $t('whatsapp.engineQrMissing') }}</p>
                    <p v-if="qr?.warning" class="wa-warning" data-testid="whatsapp-qr-warning">
                      {{ $t('whatsapp.qrWarning', [qr.refreshCount]) }}
                    </p>
                    <p class="wa-footer">{{ riskAccepted ? $t('whatsapp.qrFooter') : $t('whatsapp.qrFooterLocked') }}</p>
                  </div>
                </div>

                <div v-else class="wa-phone-pane" data-testid="whatsapp-phone-pane">
                  <h2>{{ $t('whatsapp.phoneTitle') }}</h2>
                  <p>{{ $t('whatsapp.phoneDesc') }}</p>
                  <div class="wa-phone-form">
                    <label class="wa-field">
                      <span>{{ $t('whatsapp.countryCode') }}</span>
                      <select v-model="region" class="select" data-testid="whatsapp-country" :disabled="busy === 'pair'">
                        <option v-for="item in countryOptions" :key="item.region" :value="item.region">
                          {{ item.label }}
                        </option>
                      </select>
                    </label>
                    <label class="wa-field grow">
                      <span>{{ $t('whatsapp.phoneNumber') }}</span>
                      <input
                        ref="phoneInput"
                        class="input"
                        inputmode="numeric"
                        autocomplete="tel-national"
                        :placeholder="$t('whatsapp.phonePlaceholder')"
                        :value="national"
                        data-testid="whatsapp-phone-input"
                        :disabled="busy === 'pair'"
                        @input="onNationalInput"
                        @keyup.enter="generatePairingCode"
                      />
                    </label>
                    <button
                      class="kbtn primary"
                      :disabled="!riskAccepted || !phoneValid || busy === 'pair'"
                      data-testid="whatsapp-generate-code"
                      @click="generatePairingCode"
                    >
                      {{ busy === 'pair' ? $t('whatsapp.generatingCode') : $t('whatsapp.generateCode') }}
                    </button>
                  </div>
                  <p class="wa-phone-hint">{{ $t('whatsapp.phoneHint', [e164 || dialCode]) }}</p>
                  <p v-if="actionError" class="wa-field-error" data-testid="whatsapp-action-error">{{ actionError }}</p>
                  <p v-if="!riskAccepted" class="wa-note">{{ $t('whatsapp.phoneNeedRisk') }}</p>

                  <div v-if="pairing" class="wa-code-card" data-testid="whatsapp-pairing-card">
                    <div class="wa-code" :class="{ expired: pairingExpired }" aria-live="polite" data-testid="whatsapp-pairing-code">
                      {{ pairingGrouped }}
                    </div>
                    <div class="wa-code-meta">
                      <span v-if="!pairingExpired">{{ $t('whatsapp.codeRemaining', [pairingRemaining]) }}</span>
                      <span v-else>{{ $t('whatsapp.codeExpiredNote') }}</span>
                      <span>{{ $t('whatsapp.codeForPhone', [pairingPhone]) }}</span>
                    </div>
                    <div class="wa-code-actions">
                      <button
                        class="kbtn sm"
                        :disabled="pairingExpired"
                        data-testid="whatsapp-pairing-copy"
                        @click="copyPairingCode"
                      >
                        {{ $t('whatsapp.codeCopy') }}
                      </button>
                      <button
                        class="kbtn sm"
                        :disabled="!canUseAction('pair')"
                        data-testid="whatsapp-pairing-regenerate"
                        @click="generatePairingCode"
                      >
                        {{ busy === 'pair' ? $t('whatsapp.codeRegenerating') : $t('whatsapp.codeRegenerate') }}
                      </button>
                    </div>
                    <p class="wa-code-note">{{ $t('whatsapp.codeOnlyMemory') }}</p>
                  </div>
                  <div v-else-if="busy === 'pair'" class="wa-code-card">
                    <span class="spinner" aria-hidden="true"></span>
                    <p class="wa-code-note">{{ $t('whatsapp.generatingCode') }}</p>
                  </div>

                  <ol class="wa-steps phone">
                    <li><span>1</span><div>{{ $t('whatsapp.phoneStep1') }}</div></li>
                    <li><span>2</span><div>{{ $t('whatsapp.phoneStep2') }}</div></li>
                    <li><span>3</span><div>{{ $t('whatsapp.phoneStep3') }}</div></li>
                    <li><span>4</span><div>{{ $t('whatsapp.phoneStep4') }}</div></li>
                  </ol>
                  <p class="wa-chain">{{ $t('whatsapp.phoneChain') }}</p>
                  <p class="wa-footer">{{ $t('whatsapp.phoneFailedBody') }}</p>
                </div>
              </section>
            </template>

            <section class="card wa-strip-card">
              <div class="wa-strip-head">
                <h2>{{ $t('whatsapp.stateStripTitle') }}</h2>
                <span>{{ $t('whatsapp.stateStripHint') }}</span>
              </div>
              <div class="wa-strip" data-testid="whatsapp-state-strip">
                <div
                  v-for="item in STATE_STRIP"
                  :key="item.key"
                  class="wa-strip-item"
                  :class="{ on: activeConnection === item.key }"
                >
                  <span class="wa-dot" :class="item.key" aria-hidden="true"></span>
                  <div>
                    <strong>{{ $t(item.label) }}</strong>
                    <span>{{ $t(item.desc) }}</span>
                  </div>
                </div>
              </div>
            </section>

            <section class="card wa-limits">
              <div class="wa-limits-head">
                <h2>{{ $t('whatsapp.limitsTitle') }}</h2>
                <span>{{ $t('whatsapp.limitsCount', [linkedSlots]) }}</span>
              </div>
              <div class="wa-limit-grid">
                <div class="wa-limit">
                  <strong>{{ $t('whatsapp.limitDevicesTitle') }}</strong>
                  <p>{{ $t('whatsapp.limitDevicesBody', [limits.linkedDevices]) }}</p>
                </div>
                <div class="wa-limit">
                  <strong>{{ $t('whatsapp.limitPhoneTitle') }}</strong>
                  <p>{{ $t('whatsapp.limitPhoneBody', [limits.phoneOfflineDays]) }}</p>
                </div>
                <div class="wa-limit">
                  <strong>{{ $t('whatsapp.limitIdleTitle') }}</strong>
                  <p>{{ $t('whatsapp.limitIdleBody', [limits.deviceIdleDays]) }}</p>
                </div>
                <div class="wa-limit">
                  <strong>{{ $t('whatsapp.limitMethodTitle') }}</strong>
                  <p>{{ $t('whatsapp.limitMethodBody') }}</p>
                </div>
              </div>
              <p class="wa-limits-footer">{{ $t('whatsapp.limitsFooter') }}</p>
            </section>

            <section id="whatsapp-tos" ref="tosEl" class="card wa-tos" data-testid="whatsapp-tos">
              <h2>{{ $t('whatsapp.tosTitle') }}</h2>
              <p class="wa-tos-full">{{ $t('whatsapp.tosFull') }}</p>
              <blockquote>
                <p>{{ $t('whatsapp.tosWhatsAppQuote') }}</p>
                <cite>{{ $t('whatsapp.tosWhatsAppQuoteSource') }}</cite>
              </blockquote>
              <blockquote>
                <p>{{ $t('whatsapp.tosOfficialQuote') }}</p>
                <cite>{{ $t('whatsapp.tosOfficialQuoteSource') }}</cite>
              </blockquote>
              <p class="wa-tos-always">{{ $t('whatsapp.tosAlwaysOn') }}</p>
            </section>
          </div>

          <aside class="wa-aside">
            <section class="card wa-aside-card" data-testid="whatsapp-aside-risk">
              <h2>{{ $t('whatsapp.sideRisk') }}</h2>
              <p data-testid="whatsapp-aside-risk-note">{{ $t('whatsapp.riskAsideNote') }}</p>
              <p class="wa-aside-status" :class="{ 'is-good': riskAccepted }">
                {{ riskAccepted ? $t('whatsapp.sideRiskAcceptedYes') : $t('whatsapp.sideRiskAcceptedNo') }}
              </p>
              <button class="link" type="button" @click="scrollToTos">
                {{ riskAccepted ? $t('whatsapp.riskAcceptedLink') : $t('whatsapp.riskFullLink') }}
              </button>
            </section>
            <section class="card wa-aside-card">
              <h2>{{ $t('whatsapp.cloudTitle') }}</h2>
              <p>{{ $t('whatsapp.cloudBody') }}</p>
              <span class="tag">{{ $t('whatsapp.cloudTag') }}</span>
            </section>
            <section class="card wa-aside-card">
              <h2>{{ $t('whatsapp.zeroTitle') }}</h2>
              <p><strong>{{ $t('whatsapp.zeroStrong') }}</strong></p>
              <p>{{ $t('whatsapp.zeroBody') }}</p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  </main>

  <UiModal v-if="logoutOpen" :title="$t('whatsapp.logoutTitle')" @close="closeLogout">
    <p class="wa-modal-body">{{ $t('whatsapp.logoutBody') }}</p>
    <label class="wa-check">
      <input v-model="logoutChecked" type="checkbox" data-testid="whatsapp-logout-check" />
      <span>{{ $t('whatsapp.logoutCheck') }}</span>
    </label>
    <template #footer>
      <button class="kbtn" :disabled="busy === 'logout'" @click="closeLogout">
        {{ $t('whatsapp.logoutCancel') }}
      </button>
      <button
        class="kbtn danger"
        :disabled="!logoutChecked || busy === 'logout'"
        data-testid="whatsapp-logout-confirm"
        @click="confirmLogout"
      >
        {{ busy === 'logout' ? $t('whatsapp.loggingOut') : $t('whatsapp.logoutConfirm') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.wa-suggest {
  margin: 0 16px 8px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-muted);
}
.wa-suggest-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.wa-suggest-title {
  font-weight: 600;
}
.wa-suggest-src {
  color: var(--text-tertiary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-suggest-text {
  margin: 6px 0 8px;
  font-size: 13.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow: auto;
}
.wa-suggest-actions {
  display: flex;
  gap: 6px;
}

/* ───────────────────────── 会话页布局 ───────────────────────── */

.doc-chat {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.wa-chat {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: 320px minmax(0, 1fr);
  background: var(--window);
}

.wa-chat.with-profile {
  grid-template-columns: 320px minmax(0, 1fr) 300px;
}

@media (max-width: 1180px) {
  .wa-chat.with-profile {
    grid-template-columns: 280px minmax(0, 1fr) 260px;
  }
}

.wa-list-tabs {
  display: flex;
  gap: 16px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
}

.wa-list-tabs button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0 9px;
  border: 0;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
}

.wa-list-tabs button.on {
  color: var(--accent);
  font-weight: 600;
}

.wa-list-tabs button.on::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  content: '';
}

.wa-list-tab-n {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.wa-group {
  margin: 10px 10px 4px;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 550;
}

.wa-pin {
  flex: none;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.7;
}

.wa-conv-tags {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  overflow: hidden;
}

.wa-conv-tag {
  flex: none;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: var(--info-soft);
  color: var(--info-text);
  font-size: 10.5px;
  font-weight: 550;
  line-height: 18px;
  white-space: nowrap;
}

.wa-conv.on .wa-conv-tag {
  background: color-mix(in srgb, var(--on-accent) 20%, transparent);
  color: var(--on-accent);
}

.wa-side-label {
  margin: 14px 10px 4px;
}

.wa-head-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
}

.wa-head-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
}

.wa-head-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.wa-head-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-secondary);
}

.wa-head-btn:hover:not(.on),
.wa-head-icon:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.wa-head-icon.on {
  color: var(--accent);
}

.wa-head-btn svg,
.wa-head-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wa-bubble-trans {
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px solid var(--line);
  color: var(--text-secondary);
  font-size: 12.5px;
  white-space: pre-wrap;
}

.wa-chat-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.wa-chat-list-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex: none;
  padding: 15px 14px 12px;
  border-bottom: 1px solid var(--line-faint);
}

.wa-chat-list-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.wa-chat-list-meta {
  margin: 3px 0 0;
  color: var(--text-tertiary);
  font-size: 11.5px;
}

.wa-chat-list-head .kbtn {
  flex: none;
}

.wa-conv-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 12px;
}

.wa-conv {
  display: flex;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.wa-conv:hover {
  background: var(--surface-hover);
}

.wa-conv.on {
  background: var(--accent);
  color: var(--on-accent);
}

.wa-conv.on .wa-conv-top strong,
.wa-conv.on .wa-conv-top time,
.wa-conv.on .wa-conv-preview {
  color: var(--on-accent);
}

.wa-conv.on .wa-conv-top time,
.wa-conv.on .wa-conv-preview {
  opacity: 0.82;
}

.wa-conv.on .wa-unread {
  background: var(--on-accent);
  color: var(--accent);
}

.wa-filter-empty {
  padding: 16px 10px;
  text-align: center;
}

.wa-side-filters {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 10px 0 4px;
}

.wa-side-filters .nav-row.on {
  background: var(--accent);
  color: var(--on-accent);
}

.wa-side-filters .nav-row.on .count {
  color: var(--on-accent);
  opacity: 0.85;
}

.wa-conv-body {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.wa-conv-top,
.wa-conv-bottom {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.wa-conv-top strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wa-conv-top time {
  flex: none;
  color: var(--text-quaternary);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.wa-conv-bottom {
  align-items: center;
  gap: 6px;
}

.wa-conv-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wa-unread {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.wa-conv-more {
  width: 100%;
  padding: 9px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}

.wa-conv-more:hover {
  background: var(--surface-hover);
  color: var(--text-secondary);
}

.wa-new {
  flex: none;
  margin: 10px 12px 2px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.wa-new h3 {
  margin: 0;
  font-size: 13px;
}

.wa-new > p {
  margin: 4px 0 10px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.55;
}

.wa-new-field {
  display: block;
  margin-top: 8px;
}

.wa-new-field span {
  display: block;
  margin-bottom: 4px;
  color: var(--text-secondary);
  font-size: 11.5px;
}

.wa-new-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}

.wa-new-error {
  margin: 8px 0 0;
  color: var(--danger-text);
  font-size: 11.5px;
}

/* ───────────────────────── 消息流 ───────────────────────── */

.wa-chat-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--surface-soft);
}

.wa-chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 58px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: var(--window);
}

.wa-chat-head-name {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.wa-chat-head-name strong {
  overflow: hidden;
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wa-chat-head-name span {
  color: var(--text-tertiary);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.wa-chat-offline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  margin: 10px 18px 0;
  padding: 10px 12px;
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
}

.wa-chat-offline strong {
  font-size: 12.5px;
}

.wa-chat-offline p {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.wa-chat-offline .kbtn {
  flex: none;
}

.wa-stream {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 16px 22px 18px;
}

.wa-stream-more {
  align-self: center;
  margin-bottom: 4px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--window);
  color: var(--text-tertiary);
  font-size: 11.5px;
  cursor: pointer;
}

.wa-day {
  display: flex;
  justify-content: center;
  margin: 8px 0 2px;
}

.wa-day span {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--secondary-bg);
  color: var(--text-tertiary);
  font-size: 10.5px;
}

.wa-msg {
  display: flex;
}

.wa-msg.out {
  justify-content: flex-end;
}

.wa-bubble {
  max-width: min(68%, 560px);
  padding: 8px 11px 6px;
  border: 1px solid var(--line-faint);
  border-radius: 14px 14px 14px 4px;
  background: var(--window);
  box-shadow: var(--shadow-1);
}

.wa-msg.out .wa-bubble {
  border-color: transparent;
  border-radius: 14px 14px 4px 14px;
  background: var(--chat-user-bg);
  color: var(--chat-user-text);
}

.wa-msg.failed .wa-bubble {
  border-color: var(--danger-line);
}

.wa-bubble-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.wa-bubble-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 3px;
  color: var(--text-quaternary);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.wa-msg.out .wa-bubble-meta {
  color: rgba(255, 255, 255, 0.62);
}

.wa-msg.failed .wa-bubble-meta {
  color: var(--danger-text);
}

.wa-bubble-error {
  margin: 4px 0 0;
  color: var(--danger-text);
  font-size: 10.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.wa-bubble-retry {
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--danger-text);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.wa-bubble-retry:hover {
  text-decoration: underline;
}

/* ───────────────────────── 输入与翻译 ───────────────────────── */

.wa-composer {
  flex: none;
  padding: 10px 18px 14px;
  border-top: 0;
  background: var(--window);
}

@keyframes wa-spin {
  to {
    transform: rotate(360deg);
  }
}

.wa-translate-error strong {
  display: block;
  margin-top: 6px;
  color: var(--danger-text);
  font-size: 12px;
}

.wa-translate-error p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.wa-translate-error .wa-translate-code {
  color: var(--danger-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}

.wa-code-chip {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.72);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.wa-composer-input {
  flex: 1;
  min-height: 44px;
  max-height: 140px;
  line-height: 1.5;
  resize: none;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.wa-composer-input:focus {
  box-shadow: none;
}

.wa-send {
  flex: none;
  height: 34px;
  border-radius: var(--radius-pill);
}

.wa-composer-error {
  margin: 6px 0 0;
  color: var(--danger-text);
  font-size: 11.5px;
}

.wa-chat-blank {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 24px;
}

@media (max-width: 980px) {
  .wa-chat {
    grid-template-columns: 250px minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .wa-chat {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 240px) minmax(0, 1fr);
  }

  .wa-chat-list {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .wa-stream {
    padding: 14px;
  }

  .wa-composer {
    padding: 10px 12px 12px;
  }
}

.wa-channels {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

.wa-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 42px 24px;
  text-align: center;
}

.wa-loading h2 {
  margin: 0;
  font-size: 16px;
}

.wa-loading p {
  max-width: 520px;
  margin: 0;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.65;
}

.wa-loading .kbtn {
  margin-top: 4px;
}

.wa-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.wa-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.wa-sub {
  max-width: 760px;
  margin: 5px 0 0;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.65;
}

.wa-head-state {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wa-head-phone {
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.wa-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--secondary-bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.wa-pill.good {
  background: var(--good-soft);
  color: var(--good);
}

.wa-pill.warn {
  background: var(--warn-soft);
  color: var(--warn-text);
}

.wa-pill.bad {
  background: var(--danger-soft);
  color: var(--danger-text);
}

.wa-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

.wa-primary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.wa-aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wa-aside-card {
  padding: 14px 15px;
}

.wa-aside-card h2 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.wa-aside-card p {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.65;
}

.wa-aside-card .tag {
  margin-top: 9px;
}

.wa-aside-status {
  margin: 8px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.wa-aside-status.is-good {
  color: var(--good);
}

.wa-aside-card .link {
  margin-top: 6px;
  padding: 0;
  font-size: 12px;
}

.wa-main-card {
  min-width: 0;
  padding: 20px;
}

.wa-engine {
  display: flex;
  gap: 14px;
  padding: 20px;
}

.wa-engine-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--warn-line);
  border-radius: 50%;
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 16px;
  font-weight: 700;
}

.wa-engine-copy {
  min-width: 0;
}

.wa-engine-copy h2 {
  margin: 0;
  font-size: 15px;
}

.wa-engine-copy > p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-engine-doc {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--text-tertiary);
  font-size: 12px;
  flex-wrap: wrap;
}

.wa-engine-doc code {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--secondary-bg);
  font-size: 11.5px;
}

.wa-risk-gate {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-md);
  background: var(--warn-soft);
}

.wa-risk-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.wa-risk-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--warn-text);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}

.wa-risk-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.wa-risk-head p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-risk-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.wa-risk-list li {
  position: relative;
  padding-left: 13px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}

.wa-risk-list li::before {
  position: absolute;
  top: 8px;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--warn-text);
  content: '';
}

.wa-risk-list strong {
  margin-right: 4px;
  color: var(--text);
  font-weight: 600;
}

.wa-risk-liability {
  margin: 12px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
  cursor: pointer;
  user-select: none;
}

.wa-check input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}

.wa-risk-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.wa-risk-hint {
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-risk-accepted {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  margin-bottom: 16px;
  padding: 13px 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
}

.wa-risk-accepted p {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-stamp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--good-line);
  border-radius: 999px;
  background: var(--good-soft);
  color: var(--good);
  font-size: 12px;
  font-weight: 600;
}

.wa-mode-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.wa-mode-label {
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-mode-note {
  color: var(--warn-text);
  font-size: 12px;
}

.wa-qr-pane {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
  margin-top: 16px;
}

.wa-qr-col {
  min-width: 0;
}

.wa-qr-frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: #fff;
}

.wa-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}

.wa-qr-frame.locked::before {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(0, 0, 0, 0.08) 1px, transparent 1px);
  background-size: 12px 12px;
  content: '';
}

.wa-qr-frame.expired img {
  opacity: 0.3;
  filter: blur(5px) saturate(0.3);
}

.wa-qr-cover {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.84);
  color: #6b6b6b;
  text-align: center;
}

.wa-qr-cover strong {
  color: #333;
  font-size: 13px;
  line-height: 1.45;
}

.wa-qr-cover span {
  font-size: 12px;
  line-height: 1.5;
}

.wa-qr-validity {
  margin: 7px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.wa-qr-refresh-count {
  margin: 3px 0 0;
  color: var(--text-quaternary);
  font-size: 11.5px;
  text-align: center;
}

.wa-qr-info h2,
.wa-phone-pane h2 {
  margin: 0;
  font-size: 14px;
}

.wa-qr-info > p,
.wa-phone-pane > p {
  margin: 5px 0 0;
  color: var(--text-tertiary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.wa-steps.phone {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 16px;
}

.wa-steps li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.wa-steps li > span {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--secondary-bg);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
}

.wa-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.wa-note,
.wa-footer {
  margin: 10px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.wa-footnote {
  margin: 9px 0 0;
  color: var(--text-quaternary);
  font-size: 11.5px;
  line-height: 1.55;
}

.wa-warning {
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 12px;
  line-height: 1.55;
}

.wa-phone-form {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-top: 14px;
}

.wa-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-field.grow {
  flex: 1;
  min-width: 0;
}

.wa-field .input,
.wa-field .select {
  width: 100%;
}

.wa-phone-hint {
  margin: 7px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-field-error {
  margin: 7px 0 0;
  color: var(--danger-text);
  font-size: 12px;
  line-height: 1.55;
}

.wa-code-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  text-align: center;
}

.wa-code {
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.12em;
}

.wa-code.expired {
  opacity: 0.45;
}

.wa-code-meta {
  display: flex;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
  color: var(--text-tertiary);
  font-size: 12.5px;
}

.wa-code-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}

.wa-code-note {
  margin: 8px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.55;
}

.wa-chain {
  margin: 12px 0 0;
  padding: 9px 11px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.wa-state-panel {
  display: flex;
  gap: 15px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
}

.wa-state-panel.good {
  border-color: var(--good-line);
  background: var(--good-soft);
}

.wa-state-panel.bad {
  border-color: var(--danger-line);
  background: var(--danger-soft);
}

.wa-state-panel.warn {
  border-color: var(--warn-line);
  background: var(--warn-soft);
}

.wa-state-tile {
  display: grid;
  place-items: center;
  flex: none;
  width: 52px;
  height: 52px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 18px;
  font-weight: 700;
}

.wa-state-panel.good .wa-state-tile {
  border-color: var(--good-line);
  color: var(--good);
}

.wa-state-panel.bad .wa-state-tile {
  border-color: var(--danger-line);
  color: var(--danger-text);
}

.wa-state-panel.warn .wa-state-tile {
  border-color: var(--warn-line);
  color: var(--warn-text);
}

.wa-state-copy {
  flex: 1;
  min-width: 0;
}

.wa-state-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.wa-state-heading h2 {
  margin: 0;
  font-size: 15px;
}

.wa-state-copy > p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}

.wa-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 16px;
  margin: 14px 0 0;
}

.wa-facts > div {
  min-width: 0;
}

.wa-facts dt {
  color: var(--text-tertiary);
  font-size: 11.5px;
}

.wa-facts dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 13px;
}

.wa-error-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}

.wa-code-chip {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--secondary-bg);
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}

.wa-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}

.wa-alert.bad {
  border-color: var(--danger-line);
  background: var(--danger-soft);
  color: var(--danger-text);
}

.wa-alert.warn {
  border-color: var(--warn-line);
  background: var(--warn-soft);
  color: var(--warn-text);
}

.wa-alert strong {
  font-weight: 600;
}

.wa-strip-card {
  padding: 14px 18px;
}

.wa-strip-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.wa-strip-head h2 {
  margin: 0;
  font-size: 13.5px;
}

.wa-strip-head span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.wa-strip-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
}

.wa-strip-item.on {
  border-color: var(--line-strong);
  background: var(--surface-soft);
  color: var(--text);
}

.wa-strip-item .wa-dot {
  margin-top: 4px;
}

.wa-strip-item strong {
  display: block;
  font-size: 12px;
}

.wa-strip-item div > span {
  display: block;
  margin-top: 1px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
}

.wa-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-quaternary);
}

.wa-dot.connected {
  background: var(--good);
  box-shadow: 0 0 0 3px var(--good-soft);
}

.wa-dot.connecting {
  background: var(--warn-text);
  animation: wa-pulse 1.4s ease-in-out infinite;
}

.wa-dot.reauth {
  background: var(--danger);
}

.wa-dot.disconnected {
  background: var(--text-quaternary);
}

@keyframes wa-pulse {
  50% {
    opacity: 0.35;
  }
}

.wa-limits {
  padding: 18px;
}

.wa-limits-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.wa-limits-head h2 {
  margin: 0;
  font-size: 14px;
}

.wa-limits-head span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-limit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.wa-limit {
  padding: 11px 12px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
}

.wa-limit strong {
  display: block;
  font-size: 12.5px;
}

.wa-limit p {
  margin: 5px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.wa-limits-footer {
  margin: 12px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.wa-tos {
  padding: 20px;
  scroll-margin-top: 16px;
}

.wa-tos h2 {
  margin: 0;
  font-size: 14px;
}

.wa-tos p {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.7;
}

.wa-tos ul {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.7;
}

.wa-tos blockquote {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-left: 3px solid var(--line-strong);
  background: var(--surface-soft);
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.65;
}

.wa-tos blockquote p {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-tos cite {
  display: block;
  margin-top: 6px;
  color: var(--text-quaternary);
  font-size: 11.5px;
  font-style: normal;
}

.wa-tos-always {
  padding-top: 8px;
  border-top: 1px solid var(--line-faint);
  color: var(--text-tertiary) !important;
  font-size: 12px !important;
}

.wa-side-account {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
}

.wa-side-account .wa-dot {
  margin-top: 5px;
}

.wa-side-account-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wa-side-account-text strong {
  font-size: 13px;
}

.wa-side-phone {
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.wa-side-sub {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}

.wa-side-block {
  margin-top: 14px;
}

.wa-side-block .side-label {
  padding: 0 10px 6px;
}

.wa-side-risk {
  margin: 0;
  padding: 0 10px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.wa-side-risk.is-good {
  color: var(--good);
}

.wa-side-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 14px;
  padding: 10px;
  border-top: 1px solid var(--line-faint);
  color: var(--text-tertiary);
  font-size: 12px;
}

.wa-side-meta div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.wa-side-meta span:last-child {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  text-align: right;
}

.wa-modal-body {
  margin: 0 0 4px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

@media (max-width: 1120px) {
  .wa-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .wa-aside {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .wa-limit-grid,
  .wa-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wa-aside {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .wa-main-card,
  .wa-tos {
    padding: 16px;
  }

  .wa-qr-pane {
    grid-template-columns: 1fr;
  }

  .wa-qr-frame {
    max-width: 280px;
    margin: 0 auto;
  }

  .wa-steps,
  .wa-steps.phone {
    grid-template-columns: 1fr;
  }

  .wa-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wa-phone-form {
    flex-direction: column;
    align-items: stretch;
  }

  .wa-limit-grid,
  .wa-strip {
    grid-template-columns: 1fr;
  }

  .wa-state-panel {
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wa-dot.connecting {
    animation: none;
  }
}

.wa-proxy {
  padding: 12px 16px;
  margin-bottom: 12px;
}
.wa-proxy > summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

/* ───────────────────────── 会话页定稿样式（左栏 / 列表 / 头部 / 气泡 / 输入框） ───────────────────────── */
.wa-side-new {
  font-size: 12.5px;
}
.wa-side-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  margin: 2px 12px 6px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--text-tertiary);
}
.wa-side-search svg {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.wa-side-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.wa-side-search:focus-within {
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.wa-side-label {
  margin: 14px 10px 4px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  font-weight: 550;
}
.wa-side-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wa-side-label-row .link {
  font-size: 11.5px;
}
.wa-side-filters {
  margin: 4px 0 2px;
}
.wa-side-channel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-decoration: none;
}
.wa-side-channel:hover {
  background: var(--surface-hover);
}
.wa-side-channel-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}
.wa-side-channel .wa-side-sub {
  font-size: 11px;
}
.wa-side-channel .wa-side-sub.connected {
  color: var(--good);
}
.wa-side-empty {
  padding: 4px 10px;
  font-size: 11.5px;
}
.wa-quick-row {
  position: relative;
  display: flex;
}
.wa-quick-row .nav-row {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-quick-x {
  position: absolute;
  top: 50%;
  right: 6px;
  display: none;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: var(--radius-xs);
  background: var(--surface-muted);
  color: var(--text-tertiary);
  line-height: 1;
  transform: translateY(-50%);
}
.wa-quick-row:hover .wa-quick-x,
.wa-quick-x:focus-visible {
  display: block;
}
.wa-quick-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 6px 6px;
}
.wa-quick-form .kbtn {
  align-self: flex-end;
}

.wa-chat-list-head {
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 14px 14px 10px;
  border-bottom: 0;
}
.wa-chat-list-meta {
  flex: 1;
  margin: 0;
  white-space: nowrap;
}
.wa-sort {
  field-sizing: content;
  flex: none;
  width: auto;
  height: auto;
  padding: 0;
  max-width: 92px;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.wa-list-tabs {
  gap: 14px;
  padding: 0 14px;
}
.wa-list-tabs button {
  white-space: nowrap;
}
.wa-conv {
  gap: 0;
  padding: 9px 12px 10px;
  border-radius: 0;
}
.wa-conv-scroll {
  padding: 0 0 8px;
}
.wa-conv-top {
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
}
.wa-conv-top strong {
  flex: none;
  max-width: 60%;
}
.wa-conv-company {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-conv-top time {
  margin-left: auto;
}
.wa-conv-preview {
  display: block;
  flex: none;
}
.wa-conv-bottom {
  justify-content: space-between;
  margin-top: 2px;
}
.wa-conv-tags {
  margin-top: 0;
}
.wa-conv-tag[data-tone='neutral'] {
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.wa-conv-tag[data-tone='warn'] {
  background: var(--warn-soft);
  color: var(--warn-text);
}
.wa-conv.on .wa-conv-company {
  color: var(--on-accent);
  opacity: 0.8;
}
.wa-unread {
  background: var(--danger);
  color: var(--on-danger);
}
.wa-group {
  margin: 10px 14px 4px;
}
.wa-list-foot {
  flex: none;
  margin: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--line-faint);
  color: var(--text-quaternary);
  font-size: 11px;
}

.wa-chat-head {
  gap: 10px;
}
.wa-chat-head-sub {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.wa-chat-head-sub .wa-dot {
  width: 6px;
  height: 6px;
}
.wa-head-btn.plain {
  border-color: transparent;
  background: transparent;
}
.wa-head-btn.plain svg {
  fill: currentColor;
  stroke: none;
}
.wa-menu-wrap {
  position: relative;
}
.wa-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-2);
}
.wa-menu.up {
  top: auto;
  right: auto;
  bottom: calc(100% + 6px);
  left: 0;
  max-height: 260px;
  min-width: 200px;
  overflow: auto;
}
.wa-menu button {
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-menu button:hover:not(:disabled) {
  background: var(--surface-hover);
}
.wa-menu-empty {
  margin: 0;
  padding: 8px 10px;
  color: var(--text-tertiary);
  font-size: 12px;
}
.wa-head-icon svg circle {
  fill: currentColor;
  stroke: none;
}

.wa-day span {
  background: transparent;
}
.wa-msg {
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.wa-msg.out {
  align-items: flex-end;
}
.wa-bubble {
  max-width: min(72%, 560px);
  padding: 9px 12px;
  border-radius: 14px;
}
.wa-msg.out .wa-bubble {
  border-radius: 14px;
}
.wa-bubble-body {
  font-size: 13.5px;
}
.wa-bubble-trans {
  display: flex;
  gap: 6px;
  margin-top: 7px;
  padding: 6px 8px;
  border-top: 0;
  border-radius: var(--radius-xs);
  background: var(--surface-muted);
  font-size: 12px;
}
.wa-bubble-trans svg {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 2px;
  fill: none;
  stroke: var(--text-tertiary);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.wa-bubble-meta,
.wa-msg.out .wa-bubble-meta {
  margin: 0 4px;
  color: var(--text-quaternary);
}

.wa-suggest {
  margin: 0 18px 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}
.wa-suggest-head {
  align-items: center;
}
.wa-suggest-head svg {
  flex: none;
  width: 13px;
  height: 13px;
  fill: var(--accent);
}
.wa-suggest-title {
  color: var(--accent);
}
.wa-suggest-badge {
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 10.5px;
  font-weight: 550;
}
.wa-suggest-src {
  margin-left: auto;
}

.wa-composer {
  padding: 4px 18px 14px;
  border-top: 0;
}
.wa-compose-box {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.wa-compose-box:focus-within {
  border-color: var(--focus);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.wa-composer-input {
  display: block;
  width: 100%;
  min-height: 46px;
  max-height: 160px;
  padding: 10px 12px 4px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  line-height: 1.5;
  resize: none;
}
.wa-trans-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 10px 0;
  padding: 6px 2px;
  border-top: 1px dashed var(--line);
  font-size: 12.5px;
}
.wa-trans-line svg {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--text-tertiary);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.wa-trans-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
}
.wa-trans-arrow {
  color: var(--text-quaternary);
}
.wa-trans-target {
  field-sizing: content;
  flex: none;
  width: auto;
  max-width: 120px;
  height: auto;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wa-trans-state {
  flex: none;
  color: var(--text-tertiary);
  font-size: 11.5px;
}
.wa-trans-state.ok {
  color: var(--good);
}
.wa-compose-box .wa-translate-error {
  margin: 4px 10px;
}
.wa-compose-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px 8px;
}
.wa-tool {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-tertiary);
}
.wa-tool:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.wa-tool svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linejoin: round;
}
.wa-trans-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}
.wa-trans-pill.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.wa-trans-pill svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.wa-trans-pill:focus-within {
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.wa-compose-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-quaternary);
  font-size: 11px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-send {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
}
.wa-send:disabled {
  background: var(--surface-muted);
  color: var(--text-quaternary);
  cursor: default;
}
.wa-send svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wa-trans-settings {
  padding-top: 14px;
}
.wa-trans-settings h4 {
  margin: 0 0 8px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  font-weight: 550;
}
.wa-trans-settings label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 0;
  font-size: 12.5px;
}
.wa-trans-settings label > span {
  color: var(--text-tertiary);
}
.wa-trans-settings select {
  field-sizing: content;
  width: auto;
  height: auto;
  padding: 0;
  max-width: 130px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: right;
  cursor: pointer;
}
.wa-trans-settings input[type='checkbox'] {
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
}

/* 左栏：会话 / 模板 / 渠道 */
.wa-seg {
  display: flex;
  gap: 2px;
  margin: 0 12px 10px;
  padding: 3px;
  border-radius: 999px;
  background: var(--secondary-bg);
}
.wa-seg-btn {
  flex: 1 1 0;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition:
    background var(--dur) var(--ease-out),
    color var(--dur) var(--ease-out);
}
.wa-seg-btn:hover {
  color: var(--text);
}
.wa-seg-btn.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 500;
  box-shadow: var(--shadow-control);
}
:root[data-theme='dark'] .wa-seg-btn.on {
  background: rgba(var(--ink-rgb), 0.12);
}
</style>
