<script setup lang="ts">
import { ref } from 'vue'
import UiModal from './ui/UiModal.vue'

/** 商机移到“输单”前必须填原因（契约 §10.7 LOST_REASON_REQUIRED） */
const props = defineProps<{ title: string; busy?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [reason: string] }>()
const reason = ref('')
const tried = ref(false)
function submit(): void {
  tried.value = true
  if (reason.value.trim()) emit('confirm', reason.value.trim())
}
void props
</script>

<template>
  <UiModal :title="$t('crm.lostTitle', [title])" :subtitle="$t('crm.lostSub')" :width="440" @close="emit('close')">
    <form id="lost-form" class="stack" @submit.prevent="submit">
      <label class="field">
        <span class="field-label">{{ $t('crm.lostReason') }} *</span>
        <textarea
          v-model="reason"
          class="textarea"
          name="lostReason"
          rows="3"
          maxlength="500"
          :placeholder="$t('crm.lostReasonPh')"
          autofocus
        ></textarea>
        <span v-if="tried && !reason.trim()" class="field-error">{{ $t('crm.errLostReason') }}</span>
      </label>
    </form>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('crm.cancel') }}</button>
      <button type="submit" form="lost-form" class="kbtn danger" :disabled="busy">{{ $t('crm.markLost') }}</button>
    </template>
  </UiModal>
</template>
