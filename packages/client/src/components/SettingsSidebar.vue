<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { settingsGroups } from '../lib/settings-pages'

const route = useRoute()
const active = computed(() => String(route.meta.settings ?? ''))

const groups = computed(() => settingsGroups())
</script>

<template>
  <aside class="side" :aria-label="$t('settingsSidebar.k1xpd5ab')">
    <div class="side-head">
      <h2 class="side-title">{{ $t('settingsSidebar.kyxspmz') }}</h2>
    </div>
    <nav class="side-body">
      <template v-for="group in groups" :key="group.label">
        <div v-if="group.label" class="side-label">{{ group.label }}</div>
        <RouterLink
          v-for="item in group.items"
          :key="item.key"
          class="nav-row"
          :class="{ on: active === item.key }"
          :aria-current="active === item.key ? 'page' : undefined"
          :to="item.to"
        >
          {{ item.label }}
        </RouterLink>
      </template>
    </nav>
  </aside>
</template>
