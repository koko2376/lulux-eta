<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { getDesktop, type DesktopPrefs } from '../lib/desktop'
import { errorText, toast } from '../stores/ui'

/** 设置 → 桌面：关闭窗口时最小化到托盘、开机自启动（只在桌面端显示） */
const desktop = getDesktop()
const prefs = ref<DesktopPrefs | null>(null)
const saving = ref(false)

const isMac = computed(() => prefs.value?.platform === 'darwin')

onMounted(async () => {
  if (!desktop) return
  try {
    prefs.value = await desktop.getPrefs()
  } catch (error) {
    toast.error(errorText(error))
  }
})

async function patch(next: Partial<Pick<DesktopPrefs, 'closeToTray' | 'launchAtLogin'>>): Promise<void> {
  if (!desktop || saving.value) return
  saving.value = true
  try {
    prefs.value = await desktop.setPrefs(next)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('ops.desktopTitle')" :sub="$t('ops.desktopSub')" />
    <div class="doc">
      <div class="doc-inner">
        <StateBlock v-if="!desktop" state="empty" :title="$t('ops.desktopOnly')" />
        <StateBlock v-else-if="!prefs" state="loading" />
        <section v-else class="panel" data-testid="desktop-prefs">
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('ops.closeToTray') }}</div>
              <div class="d">
                {{
                  !prefs.trayAvailable
                    ? $t('ops.trayUnavailable')
                    : isMac
                      ? $t('ops.closeToTrayMac')
                      : $t('ops.closeToTrayHint')
                }}
              </div>
            </div>
            <UiSwitch
              :model-value="prefs.closeToTray"
              :label="$t('ops.closeToTray')"
              :disabled="saving || !prefs.trayAvailable"
              @update:model-value="patch({ closeToTray: $event })"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('ops.launchAtLogin') }}</div>
              <div class="d">
                {{ prefs.launchAtLoginSupported ? $t('ops.launchAtLoginHint') : $t('ops.launchAtLoginDev') }}
              </div>
            </div>
            <UiSwitch
              :model-value="prefs.launchAtLogin"
              :label="$t('ops.launchAtLogin')"
              :disabled="saving || !prefs.launchAtLoginSupported"
              @update:model-value="patch({ launchAtLogin: $event })"
            />
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
</style>
