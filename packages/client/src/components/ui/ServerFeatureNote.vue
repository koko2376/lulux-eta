<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import * as api from '../../api'
import { auth, can } from '../../lib/session'
import { t } from '../../i18n'

/** 团队服务器模式下内核 / MCP 默认禁用的提示（契约 §5.8） */
const props = defineProps<{ feature: 'kernels' | 'mcp' }>()
const security = ref<api.SecuritySettings | null>(null)
onMounted(async () => {
  if (auth.mode === 'server') security.value = await api.getSecurity({ silent: true }).catch(() => null)
})
const disabled = computed(() =>
  security.value ? !(props.feature === 'kernels' ? security.value.allowKernels : security.value.allowMcp) : false,
)
const name = computed(() =>
  props.feature === 'kernels' ? t('serverFeatureNote.k13pd4cx') : t('serverFeatureNote.k7cjeqp'),
)
</script>

<template>
  <div
    v-if="auth.mode === 'server' && security"
    class="note"
    :class="{ warn: disabled }"
    role="note"
    data-testid="server-feature-note"
  >
    <span v-if="disabled">
      {{ $t('serverFeatureNote.k1jz0lw5') }}<b>{{ $t('serverFeatureNote.k80tkdk', [name]) }}</b
      >{{ $t('serverFeatureNote.kbjg4mq') }}
      <template v-if="can('security:manage')">
        {{ $t('serverFeatureNote.k1mwxyko') }}
        <RouterLink class="link" to="/settings/team">{{ $t('serverFeatureNote.k15m9n0q') }}</RouterLink
        >{{ $t('fmt.period') }}
      </template>
      <template v-else>{{ $t('serverFeatureNote.k1wajkog') }}</template>
    </span>
    <span v-else>
      {{ $t('serverFeatureNote.k14jxce1', [name, feature === 'mcp' ? $t('serverFeatureNote.k1l6k7sk') : '']) }}
    </span>
  </div>
</template>

<style scoped>
.note {
  margin-bottom: 16px;
}
.link {
  text-decoration: underline;
}
</style>
