<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import { t } from '../i18n'
import { STAGE_LABEL, relativeTime } from '../lib/labels'
import { DEAL_STAGE_LABEL } from '../lib/crm'
import { formatMoney } from '../lib/quote'
import { patchWhatsAppConversation } from '../lib/whatsapp'
import { toast } from '../stores/ui'
import CustomerPicker from './CustomerPicker.vue'
import CustomerFormModal from './CustomerFormModal.vue'

/**
 * WhatsApp 会话右侧的客户档案：手动关联的客户优先，否则按号码匹配联系人。
 * 只显示当前用户有权看到的客户；没有客户时可新建或关联已有客户，会话标签在这里编辑。
 */
const props = defineProps<{
  conversation: api.WhatsAppConversation
  linkMode: string
}>()
/** linked：关联 / 取消关联后，带上现在显示的客户公司名（可能按号码匹配到别的客户），供会话列表同步 */
const emit = defineEmits<{ close: []; linked: [customerName: string | null] }>()
const router = useRouter()

const profile = ref<api.WhatsAppConversationProfile | null>(null)
const loading = ref(false)
const failed = ref('')
let seq = 0

async function load(): Promise<void> {
  const id = props.conversation.id
  const mine = ++seq
  loading.value = true
  failed.value = ''
  try {
    const result = await api.getWhatsAppConversationProfile(id)
    if (mine === seq) profile.value = result
  } catch (error) {
    if (mine === seq) failed.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}
watch(() => [props.conversation.id, props.conversation.customerId], load, { immediate: true })

const customer = computed(() => profile.value?.customer ?? null)
const contact = computed(() => {
  const c = customer.value
  if (!c) return null
  return c.contacts.find((x) => x.id === profile.value?.contactId) ?? c.contacts.find((x) => x.isPrimary) ?? c.contacts[0] ?? null
})

const pickerOpen = ref(false)
const formOpen = ref(false)
const busy = ref(false)

async function link(customerId: string | null): Promise<void> {
  busy.value = true
  try {
    await patchWhatsAppConversation(props.conversation.id, { customerId })
    await load()
    emit('linked', profile.value?.customer?.company ?? null)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

function onPick(c: api.Customer): void {
  pickerOpen.value = false
  void link(c.id)
}

function onCreated(c: api.Customer): void {
  formOpen.value = false
  void link(c.id)
}

/** 号码统一显示为带 + 的 E.164 */
const phone = computed(() => {
  const value = String(props.conversation.phone ?? '').trim()
  return value && !value.startsWith('+') ? `+${value}` : value
})

/** 新建客户时预填会话里的名字和号码 */
const draftCustomer = computed(
  () =>
    ({
      company: '',
      contacts: [{ name: props.conversation.displayName, whatsapp: phone.value, isPrimary: true }],
    }) as unknown as api.Customer,
)

const tagInput = ref('')
async function saveTags(tags: string[]): Promise<void> {
  try {
    await patchWhatsAppConversation(props.conversation.id, { tags })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
function addTag(): void {
  const v = tagInput.value.replace(/\s+/g, ' ').trim().slice(0, 20)
  tagInput.value = ''
  if (!v || props.conversation.tags.includes(v)) return
  void saveTags([...props.conversation.tags, v])
}
function removeTag(tag: string): void {
  void saveTags(props.conversation.tags.filter((x) => x !== tag))
}

function openCustomer(): void {
  if (customer.value) void router.push(`/customers/${customer.value.id}`)
}
</script>

<template>
  <aside class="wp" :aria-label="t('whatsapp.profileTitle')" data-testid="whatsapp-profile">
    <header class="wp-head">
      <strong>{{ t('whatsapp.profileTitle') }}</strong>
      <button type="button" class="wp-x" :aria-label="t('whatsapp.profileClose')" :title="t('whatsapp.profileClose')" @click="emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </header>

    <div class="wp-body">
      <p v-if="loading && !profile" class="wp-muted">{{ t('whatsapp.profileLoading') }}</p>
      <p v-else-if="failed" class="wp-muted">{{ failed }}</p>

      <template v-else-if="customer">
        <section class="wp-hero">
          <h3 data-testid="whatsapp-profile-company">{{ customer.company }}</h3>
          <p v-if="customer.country" class="wp-muted">{{ customer.country }}</p>
          <div class="wp-tags">
            <span v-for="tag in customer.tags" :key="tag" class="wp-tag">{{ tag }}</span>
            <span class="wp-tag stage" :data-stage="customer.stage">{{ STAGE_LABEL[customer.stage] ?? customer.stage }}</span>
          </div>
          <p v-if="profile?.match === 'phone'" class="wp-note">{{ t('whatsapp.profileMatchedByPhone') }}</p>
        </section>

        <section v-if="contact" class="wp-sec">
          <h4>{{ t('whatsapp.profileContact') }}</h4>
          <div class="wp-card">
            <div class="wp-card-top">
              <strong>{{ contact.name || conversation.displayName }}</strong>
              <span v-if="contact.title" class="wp-muted">{{ contact.title }}</span>
              <span v-if="contact.isPrimary" class="wp-chip">{{ t('whatsapp.profilePrimary') }}</span>
            </div>
            <p v-if="contact.whatsapp || contact.phone" class="wp-line">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h3l1.5 4-2 1.3a10 10 0 0 0 6.7 6.7l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5Z" /></svg>
              {{ contact.whatsapp || contact.phone }}
            </p>
            <p v-if="contact.email" class="wp-line">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
              {{ contact.email }}
            </p>
          </div>
        </section>

        <section class="wp-sec">
          <h4>{{ t('whatsapp.profileCustomer360') }}</h4>
          <dl class="wp-kv">
            <div><dt>{{ t('whatsapp.profileCountry') }}</dt><dd>{{ customer.country || '—' }}</dd></div>
            <div><dt>{{ t('whatsapp.profileWebsite') }}</dt><dd class="wp-ellipsis">{{ customer.website || '—' }}</dd></div>
            <div><dt>{{ t('whatsapp.profileStage') }}</dt><dd>{{ STAGE_LABEL[customer.stage] ?? customer.stage }}</dd></div>
            <div><dt>{{ t('whatsapp.profileOwner') }}</dt><dd>{{ customer.ownerName || '—' }}</dd></div>
            <div>
              <dt>{{ t('whatsapp.profileLastContact') }}</dt>
              <dd>{{ conversation.lastMessageAt ? relativeTime(conversation.lastMessageAt) : '—' }}</dd>
            </div>
          </dl>
        </section>

        <section v-if="profile?.deals.length" class="wp-sec">
          <h4>{{ t('whatsapp.profileDeals') }}</h4>
          <RouterLink v-for="deal in profile.deals" :key="deal.id" :to="`/deals/${deal.id}`" class="wp-card wp-deal-card" data-testid="whatsapp-profile-deal">
            <strong class="wp-ellipsis">{{ deal.title }}</strong>
            <span v-if="deal.expectedClose" class="wp-deal-sub">{{ t('whatsapp.profileDealClose', [deal.expectedClose]) }}</span>
            <span class="wp-deal">
              <span class="wp-amount">{{ formatMoney(deal.amount, deal.currency) }}</span>
              <span class="wp-tag stage" :data-stage="deal.stage">{{ DEAL_STAGE_LABEL[deal.stage as keyof typeof DEAL_STAGE_LABEL] ?? deal.stage }}</span>
            </span>
          </RouterLink>
        </section>
      </template>

      <section v-else-if="profile" class="wp-hero" data-testid="whatsapp-profile-empty">
        <h3>{{ conversation.displayName || phone }}</h3>
        <p class="wp-muted">{{ t('whatsapp.profileNoCustomer') }}</p>
        <div class="wp-actions">
          <button type="button" class="kbtn sm primary" :disabled="busy" @click="formOpen = true">
            {{ t('whatsapp.profileCreate') }}
          </button>
          <button type="button" class="kbtn sm" :disabled="busy" data-testid="whatsapp-profile-link" @click="pickerOpen = true">
            {{ t('whatsapp.profileLink') }}
          </button>
        </div>
      </section>

      <section class="wp-sec">
        <h4>{{ t('whatsapp.profileSession') }}</h4>
        <dl class="wp-kv">
          <div><dt>{{ t('whatsapp.profilePhone') }}</dt><dd>{{ phone }}</dd></div>
          <div><dt>{{ t('whatsapp.profileLinkMode') }}</dt><dd>{{ linkMode }}</dd></div>
          <div v-if="conversation.lastMessageAt"><dt>{{ t('whatsapp.profileLastMessage') }}</dt><dd>{{ relativeTime(conversation.lastMessageAt) }}</dd></div>
        </dl>
      </section>

      <section class="wp-sec">
        <h4>{{ t('whatsapp.profileTags') }}</h4>
        <div class="wp-tags">
          <span v-for="tag in conversation.tags" :key="tag" class="wp-tag edit" data-testid="whatsapp-conv-tag">
            {{ tag }}
            <button type="button" :aria-label="t('whatsapp.profileRemoveTag', [tag])" @click="removeTag(tag)">×</button>
          </span>
        </div>
        <form class="wp-tag-form" @submit.prevent="addTag">
          <input
            v-model="tagInput"
            class="input sm"
            maxlength="20"
            :placeholder="t('whatsapp.profileTagPlaceholder')"
            :disabled="conversation.tags.length >= 8"
            data-testid="whatsapp-tag-input"
          />
        </form>
      </section>
      <slot />
    </div>

    <footer class="wp-foot">
      <button v-if="customer" type="button" class="kbtn wp-open" data-testid="whatsapp-profile-open" @click="openCustomer">
        {{ t('whatsapp.profileOpen') }}
      </button>
      <button v-if="customer && profile?.match === 'manual'" type="button" class="link wp-unlink" :disabled="busy" @click="link(null)">
        {{ t('whatsapp.profileUnlink') }}
      </button>
    </footer>

    <CustomerPicker
      v-if="pickerOpen"
      :title="t('whatsapp.profileLink')"
      :initial-query="conversation.displayName"
      @close="pickerOpen = false"
      @pick="onPick"
    />
    <CustomerFormModal v-if="formOpen" :customer="draftCustomer" @close="formOpen = false" @saved="onCreated" />
  </aside>
</template>

<style scoped>
.wp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--window);
}
.wp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  font-size: 13.5px;
}
.wp-x {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-secondary);
}
.wp-x:hover {
  background: var(--surface-hover);
}
.wp-x svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.wp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 16px 16px;
}
.wp-hero {
  padding: 14px 0 6px;
}
.wp-hero h3 {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.wp-muted {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}
.wp-note {
  margin: 8px 0 0;
  color: var(--text-tertiary);
  font-size: 11.5px;
}
.wp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}
.wp-tag,
.wp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-xs);
  background: var(--info-soft);
  color: var(--info-text);
  font-size: 11px;
  font-weight: 550;
  white-space: nowrap;
}
.wp-chip {
  margin-left: auto;
}
.wp-tag.edit {
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.wp-tag.edit button {
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  font-size: 13px;
  line-height: 1;
}
.wp-sec {
  padding-top: 14px;
}
.wp-sec h4 {
  margin: 0 0 8px;
  color: var(--text-tertiary);
  font-size: 11.5px;
  font-weight: 550;
}
.wp-card {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 12.5px;
}
.wp-card + .wp-card {
  margin-top: 6px;
}
.wp-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.wp-line {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.wp-kv {
  margin: 0;
  display: grid;
  gap: 7px;
  font-size: 12.5px;
}
.wp-kv div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.wp-kv dt {
  color: var(--text-tertiary);
  flex: none;
}
.wp-kv dd {
  margin: 0;
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}
.wp-ellipsis {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wp-deal {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.wp-amount {
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.wp-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.wp-tag-form {
  margin-top: 8px;
}
.wp-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}
.wp-foot:empty {
  display: none;
}
.wp-open {
  width: 100%;
  justify-content: center;
}
.wp-unlink {
  align-self: center;
  font-size: 12px;
}

.wp-tag.stage {
  background: var(--accent-soft);
  color: var(--accent);
}
.wp-tag.stage[data-stage='won'],
.wp-tag.stage[data-stage='closed_won'],
.wp-tag.stage[data-stage='negotiating'],
.wp-tag.stage[data-stage='negotiation'] {
  background: color-mix(in srgb, var(--good) 16%, transparent);
  color: var(--good);
}
.wp-tag.stage[data-stage='lost'],
.wp-tag.stage[data-stage='closed_lost'] {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger-text);
}
.wp-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wp-line svg {
  flex: none;
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--text-tertiary);
  stroke-width: 1.7;
  stroke-linejoin: round;
}
.wp-deal-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text);
  text-decoration: none;
}
.wp-deal-card:hover {
  background: var(--surface-hover);
}
.wp-deal-sub {
  color: var(--text-tertiary);
  font-size: 11.5px;
}
.wp-deal .wp-amount {
  font-size: 15px;
}
</style>
