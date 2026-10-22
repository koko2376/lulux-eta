<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { fatalState, isFatalVueError, reloadApp, reportFatal } from '../lib/fatal-error'

/** 包住整个路由视图：页面渲染失败时显示友好的错误页，提供“重新加载” */
const showDetail = ref(false)

onErrorCaptured((error, _instance, info) => {
  if (!isFatalVueError(String(info))) return true
  console.error(error)
  reportFatal(error)
  return false
})
</script>

<template>
  <div v-if="fatalState.error" class="fatal" role="alert" data-testid="error-boundary">
    <div class="fatal-card">
      <h1 class="fatal-title">{{ $t('ops.fatalTitle') }}</h1>
      <p class="fatal-sub">{{ $t('ops.fatalSub') }}</p>
      <div class="fatal-actions">
        <button type="button" class="kbtn primary" data-testid="error-reload" @click="reloadApp">
          {{ $t('ops.fatalReload') }}
        </button>
        <button type="button" class="kbtn" @click="showDetail = !showDetail">
          {{ showDetail ? $t('ops.fatalHideDetail') : $t('ops.fatalShowDetail') }}
        </button>
      </div>
      <pre v-if="showDetail" class="fatal-detail"
        >{{ fatalState.error.message }}
{{ fatalState.error.detail }}</pre>
    </div>
  </div>
  <slot v-else />
</template>

<style scoped>
.fatal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--bg, var(--surface));
  z-index: 50;
}
.fatal-card {
  width: min(520px, 86vw);
}
.fatal-title {
  margin: 0 0 8px;
  font-size: 18px;
}
.fatal-sub {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.fatal-actions {
  display: flex;
  gap: 8px;
}
.fatal-detail {
  margin: 16px 0 0;
  padding: 12px 14px;
  max-height: 240px;
  overflow: auto;
  border-radius: 10px;
  background: var(--surface-soft);
  color: var(--danger-text);
  font: 12px/1.6 var(--font-mono, ui-monospace, Consolas, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
