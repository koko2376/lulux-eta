<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import { askLulux } from '../lib/ask-lulux'
import { can } from '../lib/session'
import { intlLocale, t } from '../i18n'
import { errorText, toast } from '../stores/ui'

/**
 * 邮箱阅读区 → 询盘评分卡：等级 + 分数 + 对方语种、风险提示（钓鱼 / 付款诈骗 / 制裁）、逐条加减分理由、
 * 首回建议追问的信息；一键让 LULUX 按对方语种起草首回（只存草稿，不发送）。
 */
const props = defineProps<{ message: api.EmailMessage }>()
const emit = defineEmits<{ rescored: [message: api.EmailMessage] }>()
const router = useRouter()

const inquiry = computed(() => props.message.inquiry)
const open = ref(false)
const scoring = ref(false)
const RISK_FLAGS: api.InquiryFlag[] = ['phishing', 'payment_fraud', 'sanctions_hit', 'reply_to_mismatch']
const risks = computed(() => (inquiry.value?.flags ?? []).filter((flag) => RISK_FLAGS.includes(flag)))
/** 起始分（与服务端 BASE 一致）；理由合计超出 0–100 或被风险封顶时，多显示一行说明，保证列出的分数加起来等于总分 */
const BASE_SCORE = 50
const adjust = computed(() => {
  const i = inquiry.value
  if (!i) return 0
  return i.score - BASE_SCORE - i.reasons.reduce((sum, r) => sum + r.points, 0)
})
const blocked = computed(
  () =>
    risks.value.includes('phishing') || risks.value.includes('payment_fraud') || risks.value.includes('sanctions_hit'),
)

const languageName = computed(() => {
  const code = inquiry.value?.language
  if (!code) return ''
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
})

async function rescore(): Promise<void> {
  scoring.value = true
  try {
    emit('rescored', await api.scoreEmailMessage(props.message.id))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    scoring.value = false
  }
}

function draftReply(): void {
  const m = props.message
  void askLulux(router, {
    customerId: m.customerId ?? undefined,
    prompt: t('inquiry.draftPrompt', [m.id, m.from.address, m.subject || t('inquiry.noSubject')]),
  })
}
</script>

<template>
  <section v-if="inquiry" class="iq" :class="`g-${inquiry.grade}`" data-testid="inquiry-card">
    <div class="iq-head">
      <span class="iq-grade" :title="$t('inquiry.gradeHint')">{{ inquiry.grade }}</span>
      <div class="iq-title">
        <b>{{ $t('inquiry.title', [inquiry.score]) }}</b>
        <span class="iq-sub"
          >{{ $t(`inquiry.grade${inquiry.grade}`)
          }}<template v-if="languageName"> · {{ $t('inquiry.language', [languageName]) }}</template></span
        >
      </div>
      <span class="iq-spacer"></span>
      <button type="button" class="ghost-btn" :aria-expanded="open" data-testid="inquiry-toggle" @click="open = !open">
        {{ open ? $t('inquiry.hide') : $t('inquiry.why') }}
      </button>
      <button v-if="can('data:write')" type="button" class="ghost-btn" :disabled="scoring" @click="rescore">
        {{ scoring ? $t('inquiry.scoring') : $t('inquiry.rescore') }}
      </button>
      <button v-if="!blocked" type="button" class="black-btn" data-testid="inquiry-draft" @click="draftReply">
        {{ $t('inquiry.draft') }}
      </button>
    </div>
    <ul v-if="risks.length" class="iq-risks" role="alert">
      <li v-for="flag in risks" :key="flag">{{ $t(`inquiry.risk_${flag}`) }}</li>
    </ul>
    <div v-if="open" class="iq-body">
      <ul class="iq-reasons">
        <li class="iq-base">
          <span class="pts">{{ BASE_SCORE }}</span>
          <span>{{ $t('inquiry.base') }}</span>
        </li>
        <li v-for="r in inquiry.reasons" :key="r.key">
          <span class="pts" :class="r.points >= 0 ? 'up' : 'down'">{{ r.points > 0 ? `+${r.points}` : r.points }}</span>
          <span>{{ r.label }}</span>
        </li>
        <li v-if="adjust !== 0" class="iq-adjust">
          <span class="pts" :class="adjust >= 0 ? 'up' : 'down'">{{ adjust > 0 ? `+${adjust}` : adjust }}</span>
          <span>{{ blocked ? $t('inquiry.capRisk') : $t('inquiry.capRange') }}</span>
        </li>
      </ul>
      <p v-if="inquiry.followUps.length && !blocked" class="iq-follow">
        <b>{{ $t('inquiry.followUps') }}</b
        >{{ inquiry.followUps.join($t('inquiry.sep')) }}
      </p>
      <p class="iq-note">{{ $t('inquiry.note') }}</p>
    </div>
  </section>
</template>

<style scoped>
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
  cursor: pointer;
  transition: background 0.15s ease;
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
.iq {
  margin: 10px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-soft);
}
.iq-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.iq-grade {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: var(--text-tertiary);
  flex: none;
}
.g-A .iq-grade {
  background: #1f9d55;
}
.g-B .iq-grade {
  background: #3776f9;
}
.g-C .iq-grade {
  background: #c08a1a;
}
.g-D .iq-grade {
  background: var(--danger);
}
.iq-title {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.iq-title b {
  font-size: 13.5px;
  font-weight: 600;
}
.iq-sub {
  font-size: 12px;
  color: var(--text-secondary);
}
.iq-spacer {
  flex: 1;
}
.iq-risks {
  margin: 10px 0 0;
  padding: 8px 12px 8px 28px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--danger-text);
  background: var(--danger-soft);
}
.iq-body {
  margin-top: 10px;
  animation: iq-in 0.2s ease;
}
@keyframes iq-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.iq-reasons {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.iq-reasons li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.pts {
  flex: none;
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.pts.up {
  color: #1f9d55;
}
.pts.down {
  color: var(--danger-text);
}
.iq-follow {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.iq-follow b {
  color: var(--text);
  font-weight: 500;
}
.iq-note {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
</style>
