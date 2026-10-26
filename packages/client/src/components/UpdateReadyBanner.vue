<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getUpdater, updater, useUpdaterSubscription } from '../lib/updater'
import { errorText, toast } from '../stores/ui'

/**
 * 全局“新版本已就绪 · 重启并安装”（AUTO-UPDATE.md 5.6）：不打断的小条，可关闭，不用模态。
 * 订阅存在即表示界面接管提示，主进程不再弹原生对话框。
 */
const bridge = getUpdater()
const busy = ref(false)
let release: () => void = () => undefined

onMounted(() => {
  release = useUpdaterSubscription()
})
onBeforeUnmount(() => release())

const version = computed(() => updater.state?.available?.version ?? '')
const visible = computed(
  () =>
    Boolean(bridge) && updater.state?.status === 'downloaded' && updater.dismissedVersion !== (version.value || '*'),
)

async function install(): Promise<void> {
  if (!bridge || busy.value) return
  busy.value = true
  try {
    await bridge.install()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}
function later(): void {
  updater.dismissedVersion = version.value || '*'
}
</script>

<template>
  <div
    v-if="visible"
    class="upd-banner"
    role="status"
    aria-live="polite"
    :aria-label="$t('updateReadyBanner.k1001es2')"
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="txt"
      >{{ $t('updateReadyBanner.k1d18m4o') }}<template v-if="version"> v{{ version }}</template>
      {{ $t('updateReadyBanner.k1vc4ryh') }}</span
    >
    <button type="button" class="kbtn primary sm" :disabled="busy" @click="install">
      {{ $t('updateReadyBanner.ke7148j') }}
    </button>
    <button type="button" class="kbtn ghost sm" :title="$t('updateReadyBanner.k1y3kb2b')" @click="later">
      {{ $t('updateReadyBanner.kjvfmsc') }}
    </button>
  </div>
</template>

<style scoped>
.upd-banner {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 800;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow:
    0 8px 24px rgba(17, 17, 19, 0.12),
    0 1px 3px rgba(17, 17, 19, 0.08);
  font-size: 13px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--good);
}
.txt {
  font-weight: 500;
  white-space: nowrap;
}
</style>
