<script setup lang="ts">
/** 统一的加载 / 空 / 错误状态 */
withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error'
    title?: string
    message?: string
    compact?: boolean
  }>(),
  { title: '', message: '', compact: false },
)
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="state-block" :class="[state, { compact }]" :role="state === 'error' ? 'alert' : 'status'">
    <template v-if="state === 'loading'">
      <span class="spinner" aria-hidden="true"></span>
      <span class="state-title">{{ title || $t('stateBlock.k8206sv') }}</span>
    </template>
    <template v-else-if="state === 'empty'">
      <span class="state-title">{{ title || $t('stateBlock.k1dgqfm7') }}</span>
      <span v-if="message" class="state-msg">{{ message }}</span>
      <div v-if="$slots.default" class="state-actions"><slot /></div>
    </template>
    <template v-else>
      <span class="state-title">{{ title || $t('stateBlock.k1wge2hq') }}</span>
      <span v-if="message" class="state-msg">{{ message }}</span>
      <div class="state-actions">
        <button type="button" class="kbtn" @click="emit('retry')">{{ $t('stateBlock.k1qxrqzx') }}</button>
        <slot />
      </div>
    </template>
  </div>
</template>

<style scoped>
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 48px 20px;
  text-align: center;
  color: var(--text-secondary);
}
.state-block.compact {
  padding: 22px 16px;
}
.state-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.state-block.loading .state-title {
  font-weight: 400;
  color: var(--text-secondary);
}
.state-block.error .state-title {
  color: var(--danger-text);
}
.state-msg {
  font-size: 12.5px;
  max-width: 460px;
  line-height: 1.7;
}
.state-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--text);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
