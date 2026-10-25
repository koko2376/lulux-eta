<script setup lang="ts">
import { memberTag, sessionMemberTags, withMemberTag } from '../lib/members'
import MemberTag from './MemberTag.vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as api from '../api'
import type { Agent, MessageAttachment } from '../api'
import { getEmailMessage } from '../api/email'
import { getCapabilities } from '../api/builtin'
import * as sk from '../api/skills'
import { UPLOAD_LIMIT, uploadPath, withAttachmentNote } from '../lib/attachments'
import {
  base64Size,
  captureChip,
  captureContext,
  captureFileName,
  dataUrlBase64,
  pendingCaptures,
  takeCaptures,
  withCaptureContext,
} from '../lib/browser-capture'
import { formatBytes } from '../lib/download'
import {
  downscaleImage,
  filesFromTransfer,
  imageType,
  MAX_IMAGES,
  pastedName,
  sortFiles,
  type ImageReject,
} from '../lib/images'
import { rememberSessionImage } from '../lib/session-images'
import { draftKey, isEmptyDraft, mergeDrafts, type ComposerAttachment, type SessionDraft } from '../lib/composer-draft'
import {
  customerContext,
  dealContext,
  emailContext,
  orderContext,
  quoteContext,
  withRefContexts,
  type RefContext,
  type RefKind,
} from '../lib/composer-context'
import { can } from '../lib/session'
import { kernelReasonText, unavailableAction } from '../lib/kernel'
import { activeMention, filterMembers, insertMention, type MentionQuery } from '../lib/mention'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import AgentAvatar from './AgentAvatar.vue'
import AppIcon from './AppIcon.vue'
import LuluMascot, { type LuluState } from './LuluMascot.vue'
import { mascotOn, reduceMotionOn } from '../lib/appearance'
import ComposerAddMenu, { type AddMenuItem } from './ComposerAddMenu.vue'
import ImageLightbox from './ImageLightbox.vue'
import RecordPicker, { type PickedRecord, type RecordKind } from './RecordPicker.vue'
import PermissionPicker from './PermissionPicker.vue'
import ModelPicker from './ModelPicker.vue'
import { t } from '../i18n'

const store = useAppStore()
const draft = ref('')
const input = ref<HTMLTextAreaElement | null>(null)

const agent = computed(() => store.currentAgents[0] ?? null)
const placeholder = computed(() => {
  if (store.editing) return t('composer.k1udfe0i')
  if (store.isGroupChat) return t('composer.k1dop15s')
  // 占位文字是产品名，而不是当前内核名
  return t('agx.composerPlaceholder')
})
/** 发送前就能确定会失败的情况，直接在输入框上方说明 */
const blocker = computed(() => {
  const a = agent.value
  if (a?.kind === 'kernel' && a.available === false) {
    return {
      text: t('composer.kjs9smk', [a.name, kernelReasonText(a.unavailableReason) || t('composer.k1gztg64')]),
      to: unavailableAction(a).to,
      link: unavailableAction(a).text,
    }
  }
  if (store.ready && !store.providers.length && a?.kind !== 'kernel') {
    // 没有 providers:write（团队服务器上的普通成员）：去设置页也做不了什么，改为请管理员配置
    if (!can('providers:write')) return { text: t('composer.noModelAskAdmin'), to: null, link: '' }
    return { text: t('composer.kjikq73'), to: '/settings/models', link: t('composer.k1wa3nov') }
  }
  return null
})

/* 编辑重发：消息内容放进输入框（契约 §6.8-5）；null = 不在编辑 */
let draftBeforeEdit: string | null = null
watch(
  () => store.editing?.messageId,
  async (id, previous) => {
    if (id && store.editing) {
      if (draftBeforeEdit === null) draftBeforeEdit = draft.value
      draft.value = store.editing.content
      await nextTick()
      resize()
      input.value?.focus()
      input.value?.setSelectionRange(draft.value.length, draft.value.length)
    } else if (previous) {
      if (draftBeforeEdit !== null) draft.value = draftBeforeEdit
      draftBeforeEdit = null
      await nextTick()
      resize()
    }
  },
)

/* ── 附件：上传到会话工作区，发送时在消息里注明路径；图片另作为消息附件发给能看图的模型 ── */
type Attachment = ComposerAttachment
const attachments = ref<Attachment[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

/* ── 吉祥物露露：打字时跟着光标走，生成中思考，完成开心 / 出错惊讶 ── */
const composerBox = ref<HTMLElement | null>(null)
const luluX = ref(18)
const luluTyping = ref(false)
const luluMood = ref<'happy' | 'wow' | null>(null)
let luluTypingTimer: ReturnType<typeof setTimeout> | null = null
let luluMoodTimer: ReturnType<typeof setTimeout> | null = null
const LULU_W = 58
let mirror: HTMLDivElement | null = null
const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'borderLeftWidth',
  'borderRightWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textTransform',
  'wordSpacing',
  'textIndent',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
] as const
/** 光标在 textarea 里的横坐标：用同样式的隐藏镜像排版，自动折行也准 */
function caretLeft(ta: HTMLTextAreaElement): number {
  if (!mirror) {
    mirror = document.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      top: '0',
      left: '-9999px',
      overflow: 'hidden',
    })
    document.body.appendChild(mirror)
  }
  const style = getComputedStyle(ta)
  for (const key of MIRROR_PROPS) mirror.style[key] = style[key]
  mirror.style.width = `${ta.clientWidth}px`
  mirror.style.boxSizing = 'border-box'
  mirror.style.borderLeftWidth = '0'
  mirror.style.borderRightWidth = '0'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  const pos = ta.selectionEnd ?? ta.value.length
  mirror.textContent = ta.value.slice(0, pos)
  const mark = document.createElement('span')
  mark.textContent = ta.value.slice(pos, pos + 1) || '\u200b'
  mirror.appendChild(mark)
  return mark.offsetLeft
}
function onCaretClick(): void {
  updateMention()
  updateLulu()
}
function onCaretKey(e: KeyboardEvent): void {
  if (/^(Arrow|Home|End|Page)/.test(e.key)) updateLulu()
}
function updateLulu(): void {
  const ta = input.value
  const box = composerBox.value
  if (!ta || !box || !mascotOn.value) return
  const width = caretLeft(ta)
  // 露露的中心对准光标，限制在输入框左右边内
  const x = ta.offsetLeft + width - LULU_W / 2
  luluX.value = Math.round(Math.max(10, Math.min(box.clientWidth - LULU_W - 10, x)))
  luluTyping.value = true
  if (luluTypingTimer) clearTimeout(luluTypingTimer)
  luluTypingTimer = setTimeout(() => (luluTyping.value = false), 900)
}
// 只在当前会话自己的生成结束时开心 / 惊讶；切到另一个会话（那边空闲）不算“完成了”
watch(
  () => [store.currentSessionId, store.streaming] as const,
  ([id, now], [previousId, before]) => {
    if (id !== previousId || now || !before) return
    luluMood.value = store.error ? 'wow' : 'happy'
    if (luluMoodTimer) clearTimeout(luluMoodTimer)
    luluMoodTimer = setTimeout(() => (luluMood.value = null), 1600)
  },
)
// 输入框变窄（拖窗口、开右侧面板）时把露露收回框内
let luluResize: ResizeObserver | null = null
watch(composerBox, (box) => {
  luluResize?.disconnect()
  luluResize = null
  if (!box || typeof ResizeObserver === 'undefined') return
  luluResize = new ResizeObserver(() => {
    const max = Math.max(10, box.clientWidth - LULU_W - 10)
    if (luluX.value > max) luluX.value = max
  })
  luluResize.observe(box)
})
// 发送 / 清空后回到左边
watch(draft, (value) => {
  if (value) return
  luluX.value = 18
  luluTyping.value = false
  if (luluTypingTimer) clearTimeout(luluTypingTimer)
  luluTypingTimer = null
})
const luluShown = computed(
  () => mascotOn.value && !store.editing && !attachments.value.length && !blocker.value && !visionNotice.value,
)
const luluState = computed<LuluState>(() => {
  if (store.streaming) return 'thinking'
  if (luluMood.value) return luluMood.value
  return luluTyping.value ? 'typing' : 'idle'
})
const uploading = computed(() => attachments.value.some((a) => a.status === 'uploading'))
const readyPaths = computed(() => attachments.value.filter((a) => a.status === 'done' && !a.capture).map((a) => a.path))
const isImage = (a: Attachment): boolean => Boolean(a.image || a.capture)
/** 计入 8 张上限的图片（上传失败的不算） */
const imageCount = computed(() => attachments.value.filter((a) => isImage(a) && a.status !== 'error').length)
const readyImages = computed(() => attachments.value.filter((a) => isImage(a) && a.status === 'done'))
const lightbox = ref<{ src: string; alt: string } | null>(null)

/* ── “+”添加上下文：一次性引用（只随下一条消息发送，发送后清空），与会话绑定（固定）区分 ── */
const MAX_REFS = 6
const refs = ref<RefContext[]>([])

/* ── 草稿按会话保存：切走时把原文、附件、一次性引用存进草稿表，切回来再取出；互不串 ── */
/** 输入框现在显示的是哪个会话的草稿（null = 还没有会话的新对话） */
let draftSession: string | null = store.currentSessionId
/** 载入草稿时的账户：退出登录 / 换账号后，上一个账号的草稿直接丢掉，不存回去 */
let draftEpoch = store.accountEpoch

function revokeAll(list: Attachment[]): void {
  for (const a of list) if (a.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
}

/** 输入框里现在的草稿（编辑重发中时取编辑前的草稿，编辑内容不算草稿） */
function localDraft(): SessionDraft {
  return {
    text: draftBeforeEdit ?? draft.value,
    attachments: [...attachments.value],
    refs: [...refs.value],
  }
}

function showDraft(next: SessionDraft): void {
  draftBeforeEdit = null
  draft.value = next.text
  attachments.value = next.attachments
  refs.value = next.refs
  void nextTick(resize)
}

function loadDraft(sessionId: string | null): void {
  showDraft(store.takeDraft(sessionId))
}

loadDraft(draftSession)

watch(
  () => [store.currentSessionId, store.accountEpoch] as const,
  ([id, epoch]) => {
    picker.value = null
    mention.value = null
    if (epoch !== draftEpoch) {
      // 账号切换：上一个账号的草稿不留
      revokeAll(attachments.value)
      draftEpoch = epoch
      draftSession = id
      loadDraft(id)
      return
    }
    if (id === draftSession) return
    const previous = draftSession
    const current = localDraft()
    draftSession = id
    // 新对话（还没有会话）里写的草稿：建出会话时跟着进去
    if (previous === null && id !== null && id === store.createdSessionId) {
      const created = store.takeDraft(id)
      showDraft(isEmptyDraft(created) ? current : mergeDrafts(current, created))
      return
    }
    store.stashDraft(previous, current)
    loadDraft(id)
  },
)

/** 某个会话的附件列表：正在看的会话在输入框里，不在看的在草稿表里 */
function attachmentsOf(sessionId: string): Attachment[] {
  if (draftKey(sessionId) === draftKey(draftSession)) return attachments.value
  return store.drafts[draftKey(sessionId)]?.attachments ?? []
}

/** 退回 / 预填的草稿：只填回它所属的会话；已切走就存回那个会话的草稿表 */
watch(
  () => store.failedDraft,
  async (returned) => {
    if (!returned) return
    store.failedDraft = null
    if (draftKey(returned.sessionId) !== draftKey(draftSession)) {
      store.stashReturned(returned)
      return
    }
    const { sessionId, prefill, ...back } = returned
    void sessionId
    const mine = localDraft()
    if (prefill) {
      // 预填只在输入框为空时填入
      if (isEmptyDraft(mine)) showDraft(back)
    } else {
      showDraft(isEmptyDraft(mine) ? back : mergeDrafts(back, mine))
    }
    await nextTick()
    resize()
  },
  { immediate: true },
)
const picker = ref<RecordKind | null>(null)
const refBusy = ref(0)
const REF_ICON: Record<RefKind, string> = {
  customer: 'users',
  quote: 'file',
  email: 'message',
  deal: 'spark',
  order: 'zap',
}
// “+”菜单：引用业务记录（有读数据权限时）+ 上传文件（回形针并进来，给输入区腾地方）
const addItems = computed<AddMenuItem[]>(() => {
  const records: AddMenuItem[] = can('data:read')
    ? (['customer', 'quote', 'email', 'deal', 'order'] as const).map((id) => ({
        id,
        icon: REF_ICON[id],
        label: t(`composerContext.menu_${id}`),
        hint: t(`composerContext.menuHint_${id}`),
      }))
    : []
  return [...records, { id: 'file', icon: 'paperclip', label: t('composer.kti97r2'), hint: t('composer.kdcadgh') }]
})

function openPicker(id: string): void {
  if (id === 'file') {
    pickFiles()
    return
  }
  if (refs.value.length >= MAX_REFS) {
    toast.error(t('composerContext.tooMany', [MAX_REFS]))
    return
  }
  picker.value = id as RecordKind
}

async function onPick(picked: PickedRecord): Promise<void> {
  picker.value = null
  if (refs.value.some((r) => r.kind === picked.kind && r.id === picked.item.id)) {
    input.value?.focus()
    return
  }
  refBusy.value += 1
  try {
    let next: RefContext
    if (picked.kind === 'customer') next = customerContext(picked.item)
    else if (picked.kind === 'quote') {
      const owner = picked.item.customerId ? await api.getCustomer(picked.item.customerId).catch(() => null) : null
      next = quoteContext(picked.item, owner?.company ?? '')
    } else if (picked.kind === 'email') next = emailContext(await getEmailMessage(picked.item.id))
    else if (picked.kind === 'deal') next = dealContext(picked.item)
    else next = orderContext(picked.item)
    if (!refs.value.some((r) => r.kind === next.kind && r.id === next.id)) refs.value = [...refs.value, next]
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    refBusy.value -= 1
  }
  await nextTick()
  input.value?.focus()
}

function removeRef(r: RefContext): void {
  refs.value = refs.value.filter((x) => !(x.kind === r.kind && x.id === r.id))
}

/* ── 会话绑定（固定上下文）：在输入框里以带图钉的标签显示，× 解除对应绑定 ── */
const pinned = computed(() => {
  if (!store.currentSessionId || agent.value?.kind === 'kernel') return []
  const out: { field: 'customerId' | 'quoteId'; label: string }[] = []
  if (store.context.customerId)
    out.push({
      field: 'customerId',
      label: t('composerContext.pinnedCustomer', [store.contextNames.customer || t('composerContext.loadingName')]),
    })
  if (store.context.quoteId)
    out.push({
      field: 'quoteId',
      label: t('composerContext.pinnedQuote', [store.contextNames.quote || t('composerContext.loadingName')]),
    })
  return out
})

async function unpin(field: 'customerId' | 'quoteId'): Promise<void> {
  try {
    await store.setContext({ ...store.context, [field]: null })
    toast.success(t('chat.kamf9xb'))
  } catch {
    /* 全局 toast 已提示 */
  }
}
const hasChips = computed(() => pinned.value.length > 0 || refs.value.length > 0)

function pickFiles(): void {
  fileInput.value?.click()
}

async function onFiles(event: Event): Promise<void> {
  const el = event.target as HTMLInputElement
  const list = [...(el.files ?? [])]
  el.value = ''
  await addFiles(list)
}

function rejectText(r: ImageReject): string {
  if (r.reason === 'type') return t('vision.rejectType', [r.file.name])
  if (r.reason === 'size') return t('vision.rejectSize', [r.file.name])
  return t('vision.rejectCount', [MAX_IMAGES])
}

/** 选择 / 粘贴 / 拖放进来的文件：图片校验（格式、10 MB、8 张）后缩放上传，其他文件按普通附件上传 */
async function addFiles(list: File[]): Promise<void> {
  if (!list.length || store.editing) return
  const { images, others, rejected } = sortFiles(list, imageCount.value)
  const reasons = new Set<string>()
  for (const r of rejected) {
    const text = rejectText(r)
    if (!reasons.has(text)) toast.error(text)
    reasons.add(text)
  }
  for (const file of others) {
    if (file.size > UPLOAD_LIMIT) toast.error(t('composer.k17qtzty', [file.name]))
  }
  const plain = others.filter((file) => file.size <= UPLOAD_LIMIT)
  if (!images.length && !plain.length) return
  // 附件绑定到发起时的会话：中途切走会话，附件跟着那个会话的草稿走，不会出现在别的会话里
  const sessionId = await store.ensureSession().catch(() => null)
  if (!sessionId) return
  const taken = (await sk.listSessionFiles(sessionId).catch(() => [])).map((e) => e.path)
  const usedPaths = () => [...taken, ...attachmentsOf(sessionId).map((a) => a.path)]
  await Promise.all([
    ...images.map(async (file) => {
      const name = pastedName(file)
      const path = uploadPath(name, usedPaths())
      const item = reactiveAttachment(sessionId, {
        path,
        name,
        size: file.size,
        status: 'uploading',
        image: true,
        mime: imageType(file) ?? file.type,
        preview: URL.createObjectURL(file),
      })
      try {
        const shrunk = await downscaleImage(file)
        item.size = shrunk.blob.size
        item.width = shrunk.width
        item.height = shrunk.height
        if (shrunk.scaled) {
          URL.revokeObjectURL(item.preview!)
          item.preview = URL.createObjectURL(shrunk.blob)
        }
        const res = await sk.uploadSessionFile(sessionId, { path, dataBase64: await sk.fileToBase64(shrunk.blob) })
        item.path = res.path
        item.size = res.size
        item.status = 'done'
      } catch (error) {
        item.status = 'error'
        item.error = errorText(error)
        toast.error(t('composer.k1f5j0ja', [name, item.error]))
      }
    }),
    ...plain.map(async (file) => {
      const path = uploadPath(file.name, usedPaths())
      const item = reactiveAttachment(sessionId, { path, name: file.name, size: file.size, status: 'uploading' })
      try {
        const res = await sk.uploadSessionFile(sessionId, { path, dataBase64: await sk.fileToBase64(file) })
        item.path = res.path
        item.status = 'done'
      } catch (error) {
        item.status = 'error'
        item.error = errorText(error)
        toast.error(t('composer.k1f5j0ja', [file.name, item.error]))
      }
    }),
  ])
}

/**
 * 粘贴截图 / 图片文件：只有文件时接管粘贴，纯文字照常粘贴。
 * 剪贴板同时带文字时（从表格 / 文档复制，常附一张渲染出来的图）文字照常粘贴；
 * 只有一张图时那张图就是文字的渲染，不再上传；多个文件时文字和文件都保留。
 */
function onPaste(event: ClipboardEvent): void {
  const files = filesFromTransfer(event.clipboardData)
  if (!files.length) return
  const data = event.clipboardData
  const text = data && typeof data.getData === 'function' ? data.getData('text/plain') : ''
  if (text.trim()) {
    if (files.length === 1 && imageType(files[0])) return
    void addFiles(files)
    return
  }
  event.preventDefault()
  void addFiles(files)
}

/* 拖放文件到输入区 */
const dragging = ref(false)
let dragDepth = 0
const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event) || store.editing) return
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}
function onDragOver(event: DragEvent): void {
  if (!hasFiles(event) || store.editing) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(event: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  if (!hasFiles(event) || store.editing) return
  event.preventDefault()
  void addFiles(filesFromTransfer(event.dataTransfer))
}

/* ── 内置浏览器框选 → 截图上传为附件 + 上下文标签；上传失败时文字上下文照样发送 ── */
async function attachCaptures(): Promise<void> {
  const list = takeCaptures()
  if (!list.length) return
  // 绑定到发起时的会话（同 addFiles）
  const sessionId = await store.ensureSession().catch(() => null)
  const taken = sessionId ? (await sk.listSessionFiles(sessionId).catch(() => [])).map((e) => e.path) : []
  const listOf = (): Attachment[] => (sessionId ? attachmentsOf(sessionId) : attachments.value)
  const imagesIn = (): number => listOf().filter((a) => isImage(a) && a.status !== 'error').length
  for (const capture of list) {
    if (imagesIn() >= MAX_IMAGES) {
      toast.error(t('vision.rejectCount', [MAX_IMAGES]))
      break
    }
    const name = captureFileName(capture.url)
    const dataBase64 = dataUrlBase64(capture.image)
    const path = uploadPath(name, [...taken, ...listOf().map((a) => a.path)])
    const item = reactiveAttachment(sessionId, {
      path,
      name,
      size: base64Size(dataBase64),
      status: 'uploading',
      capture,
      preview: capture.image,
      mime: 'image/png',
      width: capture.width,
      height: capture.height,
    })
    try {
      if (!sessionId) throw new Error(t('composer.k1gztg64'))
      const res = await sk.uploadSessionFile(sessionId, { path, dataBase64 })
      item.path = res.path
      item.status = 'done'
    } catch (error) {
      item.status = 'error'
      item.error = errorText(error)
      toast.error(t('browserCapture.uploadFailed', [item.error]))
    }
  }
  await nextTick()
  input.value?.focus()
}

watch(
  () => pendingCaptures.value.length,
  (count) => {
    if (count) void attachCaptures()
  },
  { immediate: true },
)

/* 当前模型不支持看图时，在输入框上方提示（内置内核；CLI 内核按文件路径自己读图） */
const visionCaps = ref<{ providerId: string; model: string; vision: boolean } | null>(null)
const providerId = computed(() => store.currentSession?.providerId || store.defaultProvider?.id || '')
watch(
  () =>
    [
      imageCount.value > 0,
      providerId.value,
      store.providers.find((p) => p.id === providerId.value)?.model,
      store.settings.modelCapabilities,
    ] as const,
  async ([has, id]) => {
    if (!has || !id || agent.value?.kind === 'kernel') return
    const res = await getCapabilities({ providerId: id }).catch(() => null)
    if (res && providerId.value === id)
      visionCaps.value = { providerId: id, model: res.model, vision: res.capabilities.vision }
  },
  { immediate: true },
)
const visionNotice = computed(() => {
  const caps = visionCaps.value
  if (
    !imageCount.value ||
    agent.value?.kind === 'kernel' ||
    !caps ||
    caps.providerId !== providerId.value ||
    caps.vision
  )
    return ''
  return t('vision.unsupportedComposer', [caps.model])
})

onBeforeUnmount(() => {
  // 离开 Agent 页：草稿存起来，回来还在；账号已切换则丢掉
  if (draftEpoch === store.accountEpoch) store.stashDraft(draftSession, localDraft())
  else revokeAll(attachments.value)
  if (luluTypingTimer) clearTimeout(luluTypingTimer)
  if (luluMoodTimer) clearTimeout(luluMoodTimer)
  if (composingTimer) clearTimeout(composingTimer)
  luluResize?.disconnect()
  mirror?.remove()
  mirror = null
})

/** 加进发起会话的附件列表，返回响应式的那一项（上传进度写回它） */
function reactiveAttachment(sessionId: string | null, a: Attachment): Attachment {
  if (sessionId && draftKey(sessionId) !== draftKey(draftSession)) return store.addDraftAttachment(sessionId, a)
  attachments.value.push(a)
  return attachments.value[attachments.value.length - 1]
}

function removeAttachment(path: string): void {
  const gone = attachments.value.find((a) => a.path === path)
  if (gone?.preview?.startsWith('blob:')) URL.revokeObjectURL(gone.preview)
  attachments.value = attachments.value.filter((a) => a.path !== path)
}

function openPreview(a: Attachment): void {
  if (a.preview) lightbox.value = { src: a.preview, alt: a.name }
}

function resize(): void {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 168)}px`
}

const canSend = computed(
  () => (Boolean(draft.value.trim()) || (!store.editing && readyImages.value.length > 0)) && !refBusy.value,
)

async function submit(): Promise<void> {
  const content = draft.value.trim()
  if (!canSend.value || store.streaming || blocker.value || uploading.value) return
  mention.value = null
  if (store.editing) {
    draftBeforeEdit = ''
    const editing = store.editing
    draft.value = ''
    await nextTick()
    resize()
    if (editing) await store.submitEdit(content)
    input.value?.focus()
    return
  }
  const contexts = attachments.value
    .filter((a) => a.capture && a.status !== 'uploading')
    .map((a) => captureContext(a.capture!, a.status === 'done' ? a.path : null))
  const message = withAttachmentNote(
    withCaptureContext(withRefContexts(content, refs.value), contexts),
    readyPaths.value,
  )
  const sessionId = store.currentSessionId
  // 发送没被接受时原样退回的是用户敲的原文和原附件，不是上面拼好的整条消息
  const original: SessionDraft = { text: draft.value, attachments: [...attachments.value], refs: [...refs.value] }
  const images: MessageAttachment[] = readyImages.value.map((a) => {
    // 发送后消息里的缩略图直接复用本地预览，不再下载
    if (sessionId && a.preview) rememberSessionImage(sessionId, a.path, a.preview)
    return {
      kind: 'image',
      path: a.path,
      name: a.name,
      mime: a.mime || 'image/png',
      size: a.size,
      width: a.width ?? null,
      height: a.height ?? null,
    }
  })
  draft.value = ''
  attachments.value = []
  refs.value = []
  await nextTick()
  resize()
  await store.send(message, { ...(images.length ? { attachments: images } : {}), draft: original })
  input.value?.focus()
}

/* ── @成员（群聊，契约 §6.8-6） ── */
const mention = ref<MentionQuery | null>(null)
const mentionIndex = ref(0)
const mentionList = computed<Agent[]>(() => {
  if (!mention.value || !store.isGroupChat) return []
  const query = mention.value.query.trim().toLowerCase()
  const members = filterMembers(store.currentAgents, mention.value.query)
  // 也按群头衔搜（@跟单员）
  const byTag = query
    ? store.currentAgents.filter(
        (agent) => !members.includes(agent) && memberTag(store.currentSession, agent.id).toLowerCase().includes(query),
      )
    : []
  return [...members, ...byTag]
})

function updateMention(): void {
  const el = input.value
  if (!el || !store.isGroupChat) {
    mention.value = null
    return
  }
  const next = activeMention(draft.value, el.selectionStart ?? draft.value.length)
  if (next?.query !== mention.value?.query || next?.start !== mention.value?.start) mentionIndex.value = 0
  mention.value = next
}

async function pickMention(member: Agent): Promise<void> {
  const current = mention.value
  if (!current) return
  // 群头衔跟在名字后（「LULUX（跟单员）」/「LULUX #2」），服务端按这个点到具体那一位
  const tag = memberTag(store.currentSession, member.id)
  const label = !tag ? member.name : tag.startsWith('#') ? `${member.name} ${tag}` : withMemberTag(member.name, tag)
  const next = insertMention(draft.value, current, label)
  draft.value = next.text
  mention.value = null
  await nextTick()
  input.value?.focus()
  input.value?.setSelectionRange(next.caret, next.caret)
  resize()
}

function onInput(): void {
  resize()
  updateMention()
  updateLulu()
}

/* 输入法组合输入：上屏的回车不发送。部分浏览器先触发 compositionend 再触发 keydown(Enter)，
   此时 isComposing 已是 false，所以另看 keyCode 229，并在 compositionend 后的同一轮事件里继续当作组合中 */
let composing = false
let composingTimer: ReturnType<typeof setTimeout> | null = null
function onCompositionStart(): void {
  if (composingTimer) clearTimeout(composingTimer)
  composingTimer = null
  composing = true
}
function onCompositionEnd(): void {
  if (composingTimer) clearTimeout(composingTimer)
  composingTimer = setTimeout(() => {
    composing = false
    composingTimer = null
  }, 0)
}
function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || composing
}

function onKeydown(event: KeyboardEvent): void {
  const imeActive = isComposingKey(event)
  if (mentionList.value.length && !imeActive) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const n = mentionList.value.length
      mentionIndex.value = (mentionIndex.value + (event.key === 'ArrowDown' ? 1 : n - 1)) % n
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      void pickMention(mentionList.value[mentionIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      mention.value = null
      return
    }
  }
  if (event.key === 'Escape' && store.editing) {
    event.preventDefault()
    store.cancelEdit()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !imeActive) {
    event.preventDefault()
    void submit()
  }
}

function onBlur(): void {
  // 让列表里的点击先生效
  window.setTimeout(() => (mention.value = null), 150)
}
</script>

<template>
  <div
    class="composer-wrap"
    :class="{ dragging, 'has-lulu': mascotOn }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="dragging" class="composer-drop-hint" aria-hidden="true">{{ $t('vision.dropHint', [MAX_IMAGES]) }}</div>
    <p v-if="blocker" class="composer-blocker" role="status">
      {{ blocker.text }}<RouterLink v-if="blocker.to" :to="blocker.to">{{ blocker.link }}</RouterLink>
    </p>
    <div v-if="store.editing" class="composer-editing" role="status">
      <AppIcon name="edit" :size="14" />
      <span class="composer-editing-text">
        {{ $t('composer.k3s1m5o')
        }}<template v-if="store.editing.dropCount > 0">{{
          $t('composer.k1a20ojl', [store.editing.dropCount])
        }}</template>
      </span>
      <button type="button" class="composer-editing-cancel" @click="store.cancelEdit()">
        {{ $t('composer.kldkknc') }}
      </button>
    </div>
    <p v-if="visionNotice" class="composer-vision-note" role="status" data-testid="composer-vision-note">
      <AppIcon name="image" :size="13" />{{ visionNotice }}
    </p>
    <ul v-if="attachments.length" class="composer-files" :aria-label="$t('composer.k1k0uwfx')">
      <li
        v-for="a in attachments"
        :key="a.path"
        class="composer-file"
        :class="[a.status, { capture: a.capture, 'is-image': a.image && !a.capture }]"
        :title="
          a.error ||
          (a.capture
            ? `${a.capture.url}\n${a.capture.element?.selector ?? ''}`
            : a.image && a.width && a.height
              ? `${a.name} · ${a.width}×${a.height}`
              : a.path)
        "
        :data-testid="a.image && !a.capture ? 'composer-image' : undefined"
      >
        <button
          v-if="a.preview"
          type="button"
          class="composer-thumb-btn"
          :class="a.capture ? 'composer-capture-thumb' : 'composer-image-thumb'"
          :aria-label="$t('vision.open', [a.name])"
          @click="openPreview(a)"
        >
          <img :src="a.preview" alt="" />
          <span v-if="a.image && a.status === 'uploading'" class="composer-image-busy" aria-hidden="true" />
        </button>
        <AppIcon v-else name="file" :size="14" />
        <template v-if="!a.image || a.capture">
          <span class="composer-file-name">{{ a.capture ? captureChip(a.capture) : a.name }}</span>
          <span v-if="!a.capture || a.status !== 'done'" class="composer-file-size">{{
            a.status === 'uploading'
              ? $t('composer.kslfuhy')
              : a.status === 'error'
                ? $t('composer.kh9nt60')
                : formatBytes(a.size)
          }}</span>
        </template>
        <button
          type="button"
          class="composer-file-remove"
          :aria-label="a.capture ? $t('browserCapture.remove') : $t('composer.ktfl0rs', [a.name])"
          :title="a.status === 'done' ? $t('composer.k10l6lqt') : $t('composer.kd61i4g')"
          @click="removeAttachment(a.path)"
        >
          <AppIcon name="close" :size="12" />
        </button>
      </li>
    </ul>
    <RecordPicker v-if="picker" :kind="picker" @close="picker = null" @pick="onPick" />
    <ImageLightbox v-if="lightbox" :src="lightbox.src" :alt="lightbox.alt" @close="lightbox = null" />
    <div
      ref="composerBox"
      class="composer"
      :class="{ editing: Boolean(store.editing), 'has-chips': hasChips && !store.editing }"
    >
      <LuluMascot v-if="luluShown" :state="luluState" :x="luluX" :reduce-motion="reduceMotionOn" />
      <ul
        v-if="hasChips && !store.editing"
        class="composer-contexts"
        :aria-label="$t('composerContext.chipsLabel')"
        data-testid="composer-contexts"
      >
        <li
          v-for="p in pinned"
          :key="p.field"
          class="composer-ctx pinned"
          :title="$t('composerContext.pinnedTitle')"
          data-testid="composer-pinned"
        >
          <AppIcon name="pin" :size="13" />
          <span class="composer-ctx-name">{{ p.label }}</span>
          <button
            type="button"
            class="composer-ctx-remove"
            :aria-label="$t('composerContext.unpin', [p.label])"
            :title="$t('composerContext.unpin', [p.label])"
            @click="unpin(p.field)"
          >
            <AppIcon name="close" :size="11" />
          </button>
        </li>
        <li
          v-for="r in refs"
          :key="`${r.kind}:${r.id}`"
          class="composer-ctx once"
          :class="`kind-${r.kind}`"
          :title="$t('composerContext.onceTitle')"
          data-testid="composer-ref"
        >
          <AppIcon :name="REF_ICON[r.kind]" :size="13" />
          <span class="composer-ctx-name">{{ $t(`composerContext.chip_${r.kind}`, [r.label]) }}</span>
          <button
            type="button"
            class="composer-ctx-remove"
            :aria-label="$t('composerContext.removeRef', [r.label])"
            :title="$t('composerContext.removeRef', [r.label])"
            @click="removeRef(r)"
          >
            <AppIcon name="close" :size="11" />
          </button>
        </li>
        <li v-if="refBusy" class="composer-ctx once busy" role="status">{{ $t('composerContext.adding') }}</li>
      </ul>
      <ul v-if="mentionList.length" class="mention-list" role="listbox" :aria-label="$t('composer.k1n6edp6')">
        <li
          v-for="(member, i) in mentionList"
          :key="member.id"
          role="option"
          :aria-selected="i === mentionIndex"
          class="mention-item"
          :class="{ on: i === mentionIndex }"
          :title="member.description"
          @mousedown.prevent="pickMention(member)"
          @mouseenter="mentionIndex = i"
        >
          <AgentAvatar :agent-id="member.id" :size="22" />
          <span class="mention-name">{{ member.name }}</span>
          <MemberTag
            :tag="memberTag(store.currentSession, member.id)"
            :peers="sessionMemberTags(store.currentSession)"
          />
          <span class="mention-desc">{{ member.description }}</span>
        </li>
      </ul>
      <textarea
        ref="input"
        v-model="draft"
        rows="1"
        :placeholder="placeholder"
        data-composer-input
        :aria-label="$t('composer.k1bxeqfx')"
        spellcheck="false"
        @input="onInput"
        @keyup="onCaretKey"
        @click="onCaretClick"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @blur="onBlur"
        @paste="onPaste"
      />
      <input ref="fileInput" type="file" multiple hidden data-testid="composer-file" @change="onFiles" />
      <!-- 工具栏单独一行：左边“+”、权限，右边模型、发送；输入框独占上面整行 -->
      <div class="composer-toolbar">
        <ComposerAddMenu
          v-if="!store.editing"
          :items="addItems"
          :label="$t('composerContext.add')"
          :disabled="store.streaming"
          @select="openPicker"
        />
        <PermissionPicker v-if="!store.editing" />
        <span class="composer-toolbar-gap" />
        <ModelPicker v-if="!store.editing" />
        <button
          v-if="store.streaming"
          type="button"
          class="composer-send"
          :title="$t('composer.kwspz8m')"
          :aria-label="$t('composer.kwspz8m')"
          :disabled="store.currentRun?.stopping"
          @click="store.stop()"
        >
          <AppIcon name="stop" :size="16" />
        </button>
        <button
          v-else
          type="button"
          class="composer-send"
          :title="store.editing ? $t('composer.k19r5szv') : $t('composer.k50lyk3')"
          :aria-label="store.editing ? $t('composer.k19r5szv') : $t('composer.k50lyk3')"
          :disabled="!canSend || Boolean(blocker) || uploading"
          @click="submit"
        >
          <AppIcon name="arrow-up" :size="18" :stroke-width="2" />
        </button>
      </div>
    </div>
  </div>
</template>
