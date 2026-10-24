<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :class="{ on: modelValue }"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <i></i>
  </button>
</template>
