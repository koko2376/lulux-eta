<script setup lang="ts">
import { computed, ref } from 'vue'
import UiModal from './ui/UiModal.vue'
import { t } from '../i18n'

/**
 * 一次性恢复码：只在创建账户 / 找回密码 / 早期账户首次登录 / 重新生成之后显示这一次。
 * 不能用 Esc 或点遮罩关掉，必须点“我已保存”。
 */
const props = defineProps<{ code: string; reason: 'created' | 'reset' | 'legacy' | 'regenerated' }>()
const emit = defineEmits<{ done: [] }>()

const copyState = ref<'' | 'copied' | 'failed'>('')
const lead = computed(
  () =>
    ({
      created: t('recoveryCode.leadCreated'),
      reset: t('recoveryCode.leadReset'),
      legacy: t('recoveryCode.leadLegacy'),
      regenerated: t('recoveryCode.leadRegenerated'),
    })[props.reason],
)

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

async function copy(): Promise<void> {
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.code)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) ok = legacyCopy(props.code)
  copyState.value = ok ? 'copied' : 'failed'
}
</script>

<template>
  <UiModal :title="$t('recoveryCode.title')" :width="440" :dismissible="false">
    <div class="rc" data-testid="recovery-dialog">
      <p class="rc-lead">{{ lead }}</p>
      <output class="rc-code" data-testid="recovery-code" aria-live="polite">{{ code }}</output>
      <p class="rc-hint">{{ $t('recoveryCode.hint') }}</p>
      <p v-if="copyState === 'copied'" class="rc-ok" role="status">{{ $t('recoveryCode.copied') }}</p>
      <p v-else-if="copyState === 'failed'" class="field-error" role="alert">{{ $t('recoveryCode.copyFailed') }}</p>
    </div>
    <template #footer>
      <button type="button" class="kbtn" data-testid="recovery-copy" @click="copy">
        {{ $t('recoveryCode.copy') }}
      </button>
      <button type="button" class="kbtn primary" data-testid="recovery-saved" @click="emit('done')">
        {{ $t('recoveryCode.saved') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.rc-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.rc-code {
  display: block;
  padding: 14px 12px;
  border-radius: 10px;
  background: var(--surface-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 17px;
  letter-spacing: 0.08em;
  text-align: center;
  user-select: all;
  word-break: break-all;
}
.rc-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.rc-ok {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--success, #2f855a);
}
</style>
