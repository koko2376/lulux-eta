<script setup lang="ts">
defineProps<{ msg?: string }>()
</script>

<template>
  <span v-if="msg" class="field-error" role="alert">{{ msg }}</span>
</template>
