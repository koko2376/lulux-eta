<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import * as api from '../api'
import { formatBytes } from '../lib/download'
import { blobToBase64, emailErrorText, formatAddressList, parseAddressList, sendConfirmMessage } from '../lib/mail'
import { can, denyReason } from '../lib/session'
import { confirmDialog, toast } from '../stores/ui'
import { t } from '../i18n'

/**
 * 草稿编辑器：AI / Agent / 手写草稿统一在这里核对、修改、显式发送。
 * 发送一定经过二次确认，确认框完整列出发件人、收件人、抄送、密送与附件（契约 §4.6）。
 */
const props = defineProps<{ draft: api.EmailDraft; accounts: api.EmailAccount[] }>()
const emit = defineEmits<{
  saved: [draft: api.EmailDraft]
  sent: [result: { draft: api.EmailDraft; message: api.EmailMessage }]
  deleted: [id: string]
  close: []
}>()

const form = reactive({
  accountId: '',
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  text: '',
  quoteId: '',
  attachQuotePdf: false,
})
const showCc = ref(false)
const snapshot = ref('')
const dirty = computed(() => JSON.stringify(form) !== snapshot.value)
const saving = ref(false)
const sending = ref(false)
const error = ref('')
const current = ref<api.EmailDraft>(props.draft)

function fill(d: api.EmailDraft): void {
  current.value = d
  Object.assign(form, {
    accountId: d.accountId,
    to: formatAddressList(d.to),
    cc: formatAddressList(d.cc),
    bcc: formatAddressList(d.bcc),
    subject: d.subject,
    text: d.text,
    quoteId: d.quoteId ?? '',
    attachQuotePdf: d.attachQuotePdf,
  })
  showCc.value = d.cc.length > 0 || d.bcc.length > 0
  snapshot.value = JSON.stringify(form)
  error.value = d.status === 'failed' && d.error ? t('mailDraftEditor.k74gw33', [d.error]) : ''
}
fill(props.draft)
watch(
  () => props.draft,
  (d) => {
    if (d.id !== current.value.id || !dirty.value) fill(d)
  },
)

const readonly = computed(
  () => current.value.status === 'sent' || current.value.status === 'sending' || !can('data:write'),
)
const account = computed(() => props.accounts.find((a) => a.id === form.accountId) ?? null)
const fromLabel = computed(() =>
  account.value
    ? account.value.displayName
      ? `${account.value.displayName} <${account.value.email}>`
      : account.value.email
    : '',
)

/* 报价单：可选附上 */
const quotes = ref<api.Quote[]>([])
onMounted(async () => {
  try {
    quotes.value = current.value.customerId
      ? await api.listQuotesForCustomer(current.value.customerId)
      : await api.listQuotes()
  } catch {
    quotes.value = []
  }
})

function body(): api.DraftInput | null {
  const to = parseAddressList(form.to)
  const cc = parseAddressList(form.cc)
  const bcc = parseAddressList(form.bcc)
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
  if (invalid.length) {
    error.value = t('mailDraftEditor.kqjbapu', [invalid.join(t('fmt.listSep'))])
    return null
  }
  return {
    accountId: form.accountId,
    to: to.list,
    cc: cc.list,
    bcc: bcc.list,
    subject: form.subject,
    text: form.text,
    quoteId: form.quoteId || null,
    attachQuotePdf: Boolean(form.quoteId) && form.attachQuotePdf,
  }
}

async function save(silent = false): Promise<api.EmailDraft | null> {
  error.value = ''
  const b = body()
  if (!b) return null
  saving.value = true
  try {
    const saved = await api.updateEmailDraft(current.value.id, b)
    fill(saved)
    emit('saved', saved)
    if (!silent) toast.success(t('mailDraftEditor.k17pet48'))
    return saved
  } catch (e) {
    error.value = emailErrorText(e)
    return null
  } finally {
    saving.value = false
  }
}

function confirmSendAs(): Promise<boolean> {
  return confirmDialog({
    title: t('mailx.sendAsTitle'),
    message: t('mailx.sendAsMessage', [account.value?.email ?? fromLabel.value, account.value?.ownerName ?? '']),
    confirmText: t('mailx.sendAsConfirm'),
    danger: true,
  })
}

async function send(): Promise<void> {
  if (!can('email:send')) return
  const saved = dirty.value ? await save(true) : current.value
  if (!saved) return
  if (!saved.to.length) {
    error.value = t('mailDraftEditor.k1riw1qp')
    return
  }
  // 管理员用成员的邮箱发信：单独、明确地确认“以成员身份发出”（服务端会再校验并记审计）
  let sendAs = account.value?.contentAccess === 'admin'
  const ok = sendAs
    ? await confirmSendAs()
    : await confirmDialog({
        title: t('mailDraftEditor.kytx606'),
        message: sendConfirmMessage(saved, fromLabel.value),
        confirmText: t('mailDraftEditor.k3gl2d0'),
      })
  if (!ok) return
  sending.value = true
  error.value = ''
  try {
    let result: Awaited<ReturnType<typeof api.sendEmailDraft>>
    try {
      result = await api.sendEmailDraft(saved.id, { confirmSendAs: sendAs })
    } catch (e) {
      // 账户信息过期（例如刚开启设置）：服务端要求确认时再问一次
      if (sendAs || !(e instanceof api.ApiError) || e.code !== 'CONFIRM_SEND_AS' || !(await confirmSendAs())) throw e
      sendAs = true
      result = await api.sendEmailDraft(saved.id, { confirmSendAs: true })
    }
    fill(result.draft)
    toast.success(t('mailDraftEditor.k1t6257q', [formatAddressList(result.draft.to)]))
    emit('sent', result)
  } catch (e) {
    error.value = emailErrorText(e)
    // 失败时草稿状态变为 failed，拉回最新状态
    const latest = await api.getEmailDraft(saved.id).catch(() => null)
    if (latest) {
      current.value = latest
      emit('saved', latest)
    }
  } finally {
    sending.value = false
  }
}

async function remove(): Promise<void> {
  const ok = await confirmDialog({
    title: t('mailDraftEditor.k1s4dnps'),
    message: t('mailDraftEditor.k1g0urjj'),
    confirmText: t('mailDraftEditor.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  await api.deleteEmailDraft(current.value.id)
  emit('deleted', current.value.id)
}

/* 附件 */
const fileInput = ref<HTMLInputElement | null>(null)
async function onFiles(event: Event): Promise<void> {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  ;(event.target as HTMLInputElement).value = ''
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      toast.error(t('mailDraftEditor.kzti6jr', [file.name]))
      continue
    }
    try {
      const att = await api.uploadDraftAttachment(current.value.id, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64: await blobToBase64(file),
      })
      current.value = { ...current.value, attachments: [...current.value.attachments, att] }
    } catch (e) {
      toast.error(emailErrorText(e))
    }
  }
}
async function removeAttachment(att: api.DraftAttachment): Promise<void> {
  await api.deleteDraftAttachment(current.value.id, att.id)
  current.value = { ...current.value, attachments: current.value.attachments.filter((a) => a.id !== att.id) }
}

const SOURCE_LABEL = {
  user: t('mailDraftEditor.k6xq3xc'),
  ai: t('mailDraftEditor.k1s2j35j'),
  agent: t('mailDraftEditor.kvwdhhf'),
  sequence: t('seq.title'),
} as const
/** 邮箱底部回复框：建好草稿后直接走这里的发送确认 */
defineExpose({ send })
</script>

<template>
  <section
    class="draft"
    :aria-label="$t('mailDraftEditor.ki710qo', [form.subject || $t('mailDraftEditor.k1c121vb')])"
    data-testid="draft-editor"
  >
    <header class="draft-head">
      <span class="tag" :class="{ good: current.status === 'sent', bad: current.status === 'failed' }">
        {{
          current.status === 'sent'
            ? $t('mailDraftEditor.k1cr4tgy')
            : current.status === 'failed'
              ? $t('mailDraftEditor.k1s7g1n0')
              : SOURCE_LABEL[current.source]
        }}
      </span>
      <span v-if="current.ai" class="muted small">{{ current.ai.providerName }} · {{ current.ai.model }}</span>
      <span v-if="current.source !== 'user' && current.status !== 'sent'" class="muted small">
        {{ $t('mailDraftEditor.k1xfv6p0') }}
      </span>
      <span class="tb-spacer"></span>
      <button type="button" class="kbtn sm ghost" :aria-label="$t('mailDraftEditor.kv2jf0p')" @click="emit('close')">
        {{ $t('mailDraftEditor.kpwdysk') }}
      </button>
    </header>

    <div class="draft-grid">
      <label class="lbl" for="draft-from">{{ $t('mailDraftEditor.kfosvh5') }}</label>
      <select id="draft-from" v-model="form.accountId" class="select" :disabled="readonly">
        <option v-for="a in accounts" :key="a.id" :value="a.id">
          {{ a.displayName ? `${a.displayName} <${a.email}>` : a.email }}
        </option>
      </select>
      <label class="lbl" for="draft-to">{{ $t('mailDraftEditor.kmwupjj') }}</label>
      <div class="hstack nowrap">
        <input
          id="draft-to"
          v-model="form.to"
          class="input"
          name="to"
          :placeholder="$t('mailDraftEditor.ki1cq6p')"
          :readonly="readonly"
        />
        <button v-if="!showCc" type="button" class="kbtn sm ghost" @click="showCc = true">
          {{ $t('mailDraftEditor.k1nd9f5p') }}
        </button>
      </div>
      <template v-if="showCc">
        <label class="lbl" for="draft-cc">{{ $t('mailDraftEditor.kk5gb7k') }}</label>
        <input id="draft-cc" v-model="form.cc" class="input" :readonly="readonly" />
        <label class="lbl" for="draft-bcc">{{ $t('mailDraftEditor.ka9ir78') }}</label>
        <input id="draft-bcc" v-model="form.bcc" class="input" :readonly="readonly" />
      </template>
      <label class="lbl" for="draft-subject">{{ $t('mailDraftEditor.k1sg85hw') }}</label>
      <input id="draft-subject" v-model="form.subject" class="input" name="subject" :readonly="readonly" />
    </div>

    <textarea
      v-model="form.text"
      class="textarea draft-text"
      name="text"
      :aria-label="$t('mailDraftEditor.k18moclf')"
      rows="12"
      :readonly="readonly"
    ></textarea>

    <div class="draft-attach">
      <div class="hstack">
        <label class="lbl" for="draft-quote">{{ $t('mailDraftEditor.k1py8dnr') }}</label>
        <select id="draft-quote" v-model="form.quoteId" class="select" style="max-width: 280px" :disabled="readonly">
          <option value="">{{ $t('mailDraftEditor.k1n7tjuq') }}</option>
          <option v-for="q in quotes" :key="q.id" :value="q.id">
            {{ q.number }} · {{ q.currency }} {{ q.subtotal }}
          </option>
        </select>
        <label v-if="form.quoteId" class="check">
          <input v-model="form.attachQuotePdf" type="checkbox" :disabled="readonly" />{{
            $t('mailDraftEditor.kg9359z')
          }}
        </label>
        <span class="tb-spacer"></span>
        <input ref="fileInput" type="file" multiple hidden @change="onFiles" />
        <button v-if="!readonly" type="button" class="kbtn sm" @click="fileInput?.click()">
          {{ $t('mailDraftEditor.k1oy5qn6') }}
        </button>
      </div>
      <ul v-if="current.attachments.length" class="att-list">
        <li v-for="att in current.attachments" :key="att.id" class="att">
          <span class="att-name">{{ att.filename }}</span>
          <span class="muted">{{ formatBytes(att.size) }}</span>
          <button
            v-if="!readonly"
            type="button"
            class="kbtn sm ghost"
            :aria-label="$t('mailDraftEditor.kuwsq1n', [att.filename])"
            @click="removeAttachment(att)"
          >
            ×
          </button>
        </li>
      </ul>
    </div>

    <p v-if="error" class="field-error" role="alert">{{ error }}</p>

    <footer v-if="current.status !== 'sent'" class="draft-foot">
      <button v-if="can('data:write')" type="button" class="kbtn danger" @click="remove">
        {{ $t('mailDraftEditor.kor32mq') }}
      </button>
      <span class="tb-spacer"></span>
      <button v-if="can('data:write')" type="button" class="kbtn" :disabled="saving || readonly" @click="save()">
        {{ saving ? $t('mailDraftEditor.ksdjf4x') : $t('mailDraftEditor.klbdlvd') }}
      </button>
      <button
        type="button"
        class="kbtn primary"
        data-testid="draft-send"
        :disabled="sending || readonly || !can('email:send')"
        :title="can('email:send') ? '' : denyReason('email:send')"
        @click="send"
      >
        {{ sending ? $t('mailDraftEditor.k1anglmv') : $t('mailDraftEditor.kg9jw8g') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.draft {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.draft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.draft-grid {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 8px 10px;
  align-items: center;
}
.lbl {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.nowrap {
  flex-wrap: nowrap;
}
.nowrap .input {
  flex: 1;
}
.draft-text {
  min-height: 220px;
  font-size: 13.5px;
}
.att-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.att {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 4px 2px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
}
.att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.draft-foot {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
