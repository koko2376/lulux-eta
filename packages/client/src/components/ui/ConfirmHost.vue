<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { uiState } from '../../stores/ui'
import UiModal from './UiModal.vue'

const typed = ref('')
watch(
  () => uiState.confirm,
  () => {
    typed.value = ''
  },
)
const canConfirm = computed(() => {
  const need = uiState.confirm?.typeToConfirm
  return !need || typed.value.trim() === need
})
</script>

<template>
  <UiModal v-if="uiState.confirm" :title="uiState.confirm.title" :width="440" @close="uiState.confirm.resolve(false)">
    <p class="confirm-msg">{{ uiState.confirm.message }}</p>
    <label v-if="uiState.confirm.typeToConfirm" class="field">
      <span class="field-label">{{ $t('confirmHost.k16zzykd', [uiState.confirm.typeToConfirm]) }}</span>
      <input v-model="typed" class="input" autofocus spellcheck="false" />
    </label>
    <template #footer>
      <button type="button" class="kbtn" @click="uiState.confirm.resolve(false)">
        {{ $t('confirmHost.kldkknc') }}
      </button>
      <button
        type="button"
        class="kbtn primary"
        :class="{ danger: uiState.confirm.danger }"
        :disabled="!canConfirm"
        @click="uiState.confirm.resolve(true)"
      >
        {{ uiState.confirm.confirmText }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.confirm-msg {
  margin: 0 0 12px;
  font-size: 13.5px;
  color: var(--text-secondary);
  line-height: 1.7;
  white-space: pre-line;
}
</style>
