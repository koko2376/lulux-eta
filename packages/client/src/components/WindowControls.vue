<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onMaximizeChange,
  toggleMaximizeWindow,
  windowChrome,
} from '../lib/window'

/** Windows / Linux 无边框窗口右上角的 最小化 / 最大化(还原) / 关闭；mac 与浏览器模式不渲染 */
const maximized = ref(false)
let off: (() => void) | null = null
onMounted(async () => {
  if (windowChrome !== 'win') return
  off = onMaximizeChange((value) => (maximized.value = value))
  maximized.value = await isWindowMaximized()
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <div v-if="windowChrome === 'win'" class="win-controls" role="group" :aria-label="$t('windowControls.kegbvbi')">
    <button
      type="button"
      class="wc-btn"
      :title="$t('windowControls.k1k6ss79')"
      :aria-label="$t('windowControls.k1k6ss79')"
      @click="minimizeWindow"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
    </button>
    <button
      type="button"
      class="wc-btn"
      :title="maximized ? $t('windowControls.k198t4y4') : $t('windowControls.k1ojbecu')"
      :aria-label="maximized ? $t('windowControls.k198t4y4') : $t('windowControls.k1ojbecu')"
      data-testid="wc-maximize"
      @click="toggleMaximizeWindow"
    >
      <svg v-if="maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2.5 2.5V.5h7v7h-2" />
        <rect x=".5" y="2.5" width="7" height="7" />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x=".5" y=".5" width="9" height="9" />
      </svg>
    </button>
    <button
      type="button"
      class="wc-btn wc-close"
      :title="$t('windowControls.ktzla4f')"
      :aria-label="$t('windowControls.ktzla4f')"
      @click="closeWindow"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
    </button>
  </div>
</template>

<style scoped>
.win-controls {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 10000;
  display: flex;
  height: var(--wc-height);
  -webkit-app-region: no-drag;
}
.wc-btn {
  width: 46px;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text);
  cursor: default;
  -webkit-app-region: no-drag;
}
.wc-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.wc-btn:hover {
  background: var(--hover-overlay);
}
.wc-btn:active {
  background: var(--press-overlay);
}
.wc-close:hover {
  background: #c42b1c;
  color: #ffffff;
}
.wc-close:active {
  background: #b22a1b;
  color: #ffffff;
}
.wc-btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
</style>
