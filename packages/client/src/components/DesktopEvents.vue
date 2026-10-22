<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { getDesktop, isDesktopNotice } from '../lib/desktop'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'

/** 主进程推来的命令与通知：托盘“新建对话”、本地服务自动重启提示。无界面输出 */
const router = useRouter()
const store = useAppStore()
const desktop = getDesktop()
const NO_SESSION_ROUTES = new Set(['login', 'join', 'unlock'])
let offCommand: () => void = () => undefined
let offNotice: () => void = () => undefined

async function newChat(): Promise<void> {
  if (NO_SESSION_ROUTES.has(String(router.currentRoute.value.name ?? ''))) return
  try {
    await store.newSession()
    if (router.currentRoute.value.name !== 'agent') await router.push({ name: 'agent' })
  } catch (error) {
    toast.error(errorText(error))
  }
}

onMounted(() => {
  if (!desktop) return
  offCommand = desktop.onCommand((command) => {
    if (command === 'new-chat') void newChat()
  })
  offNotice = desktop.onNotice((notice) => {
    if (!isDesktopNotice(notice)) return
    if (notice.type === 'server-restarting') {
      toast.info(t('ops.serverRestarting', [Math.max(1, Math.round(notice.delayMs / 1000))]))
    } else if (notice.type === 'server-restarted') {
      toast.success(t('ops.serverRestarted'))
    } else {
      toast.error(t('ops.serverFailed'))
    }
  })
})
onBeforeUnmount(() => {
  offCommand()
  offNotice()
})
</script>

<template>
  <span hidden></span>
</template>
