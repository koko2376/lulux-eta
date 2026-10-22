<script setup lang="ts">
import type { Inline } from '../lib/markdown-lite'

defineProps<{ inlines: Inline[] }>()
</script>

<template>
  <template v-for="(part, j) in inlines" :key="j">
    <strong v-if="part.kind === 'bold'">{{ part.text }}</strong>
    <code v-else-if="part.kind === 'code'" class="md-code">{{ part.text }}</code>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
