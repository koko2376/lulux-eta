<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { transport } from '../api'
import { auth, signOut, useLocalServer } from '../lib/session'
import { getUpdater } from '../lib/updater'
import {
  compatMessage,
  refreshVersionCompat,
  resetVersionCompat,
  VERSION_RECHECK_MS,
  versionCompat,
} from '../lib/version-compat'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'
import UiModal from './ui/UiModal.vue'

/**
 * 连接团队服务器时的版本兼容提示：
 * - 主 / 次版本不同：右上角可关闭的提示条（客户端更新 → 请管理员升级服务器；客户端更旧 → 更新客户端）；
 * - 低于服务端的最低客户端版本：不可关闭的对话框，只能更新客户端、切回本机或退出登录。
 * 连上服务器时检查一次，之后每 30 分钟复查（服务器可能在使用中被升级）。
 */
const bridge = getUpdater()
const desktop = typeof window !== 'undefined' && Boolean(window.luluxAgent?.api)
let timer: ReturnType<typeof setInterval> | null = null

const serverConnected = computed(() => auth.ready && auth.mode === 'server')

async function check(): Promise<void> {
  if (!serverConnected.value) return
  await refreshVersionCompat(transport.baseUrl)
}

watch(
  () => [serverConnected.value, auth.serverUrl] as const,
  ([connected]) => {
    if (timer) clearInterval(timer)
    timer = null
    if (!connected) {
      resetVersionCompat()
      return
    }
    void check()
    timer = setInterval(() => void check(), VERSION_RECHECK_MS)
  },
  { immediate: true },
)
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})
function onVisible(): void {
  if (document.visibilityState === 'visible' && Date.now() - versionCompat.checkedAt > VERSION_RECHECK_MS) void check()
}

const result = computed(() => versionCompat.result)
const blocked = computed(() => serverConnected.value && result.value?.status === 'blocked')
const mismatch = computed(
  () =>
    serverConnected.value &&
    (result.value?.status === 'client-newer' || result.value?.status === 'client-older') &&
    versionCompat.dismissedFor !== `${result.value.serverVersion}|${result.value.clientVersion}`,
)
const message = computed(() => compatMessage(result.value))
const canUpdate = computed(() => Boolean(bridge) && result.value?.status !== 'client-newer')

function dismiss(): void {
  const r = result.value
  if (r) versionCompat.dismissedFor = `${r.serverVersion}|${r.clientVersion}`
}

async function checkUpdate(): Promise<void> {
  if (!bridge) return
  try {
    const state = await bridge.check()
    if (state.status === 'not-available') toast.info(t('versionCompat.noUpdate'))
  } catch (error) {
    toast.error(errorText(error))
  }
}

async function leave(kind: 'local' | 'logout'): Promise<void> {
  if (kind === 'local') await useLocalServer()
  else await signOut()
  resetVersionCompat()
}
</script>

<template>
  <div v-if="mismatch && !blocked" class="ver-banner" role="status" aria-live="polite" data-testid="version-banner">
    <span class="dot" aria-hidden="true"></span>
    <span class="txt">{{ message }}</span>
    <button v-if="canUpdate" type="button" class="kbtn primary sm" @click="checkUpdate">
      {{ $t('versionCompat.checkUpdate') }}
    </button>
    <button type="button" class="kbtn ghost sm" @click="dismiss">{{ $t('versionCompat.dismiss') }}</button>
  </div>
  <UiModal
    v-if="blocked"
    :title="$t('versionCompat.blockedTitle')"
    :dismissible="false"
    :width="460"
    data-testid="version-blocked"
  >
    <p class="ver-msg" data-testid="version-blocked-message">{{ message }}</p>
    <template #footer>
      <button v-if="desktop" type="button" class="kbtn" @click="leave('local')">
        {{ $t('versionCompat.useLocal') }}
      </button>
      <button type="button" class="kbtn" @click="leave('logout')">{{ $t('versionCompat.signOut') }}</button>
      <button v-if="bridge" type="button" class="kbtn primary" @click="checkUpdate">
        {{ $t('versionCompat.checkUpdate') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.ver-banner {
  position: fixed;
  top: 44px;
  right: 20px;
  z-index: 790;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(560px, calc(100vw - 40px));
  padding: 8px 8px 8px 14px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow:
    0 8px 24px rgba(17, 17, 19, 0.12),
    0 1px 3px rgba(17, 17, 19, 0.08);
  font-size: 13px;
  line-height: 1.45;
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn, #d97706);
}
.txt {
  flex: 1;
}
.ver-msg {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
</style>
