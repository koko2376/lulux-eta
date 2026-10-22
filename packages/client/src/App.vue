<script setup lang="ts">
import { locale } from './i18n'
import DesktopEvents from './components/DesktopEvents.vue'
import ErrorBoundary from './components/ErrorBoundary.vue'
import ConfirmHost from './components/ui/ConfirmHost.vue'
import ToastHost from './components/ui/ToastHost.vue'
import UpdateReadyBanner from './components/UpdateReadyBanner.vue'
import VersionCompatNotice from './components/VersionCompatNotice.vue'
import WindowControls from './components/WindowControls.vue'
</script>

<template>
  <!-- 切换语言时整体重新挂载：组件里在 setup 阶段算好的文案也随之更新 -->
  <ErrorBoundary>
    <RouterView :key="locale" />
  </ErrorBoundary>
  <DesktopEvents />
  <ToastHost />
  <ConfirmHost />
  <WindowControls />
  <UpdateReadyBanner />
  <VersionCompatNotice />
</template>
