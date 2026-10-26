<script setup lang="ts">
import { computed } from 'vue'
import { computerAgent, controlComputer } from '../stores/computer-agent'
import { errorText, toast } from '../stores/ui'
import { platform } from '../lib/window'
import { t } from '../i18n'

/**
 * 电脑操作状态条（docs/computer-use.md）：Agent 正在操作电脑时显示在输入框上方，
 * 随时可以暂停 / 继续 / 停止；用户动了鼠标自动暂停时提示原因。
 */
const ACTIONS = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'cursor']
const actionLabel = computed(() =>
  ACTIONS.includes(computerAgent.action) ? t(`computer.action_${computerAgent.action}`) : computerAgent.action,
)
const hotkey = computed(() => (platform === 'darwin' ? '⌘⌥⇧K' : 'Ctrl+Alt+Shift+K'))

async function control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
  try {
    await controlComputer(action)
  } catch (error) {
    toast.error(t('computer.controlFailed', [errorText(error)]))
  }
}
</script>

<template>
  <div class="computer-agent-bar" :class="computerAgent.state" role="status" data-testid="computer-agent-bar">
    <span class="computer-agent-dot" aria-hidden="true" />
    <span class="computer-agent-text">
      <template v-if="computerAgent.state === 'paused' && computerAgent.pauseReason === 'user-moved-mouse'">{{
        $t('computer.pausedByMouse')
      }}</template>
      <template v-else-if="computerAgent.state === 'paused'">{{ $t('computer.paused') }}</template>
      <template v-else-if="computerAgent.state === 'stopped'">{{ $t('computer.stopped') }}</template>
      <template v-else>{{ $t('computer.working', [computerAgent.step, actionLabel]) }}</template>
      <span v-if="computerAgent.state === 'running'" class="computer-agent-hint">{{
        $t('computer.hotkeyHint', [hotkey])
      }}</span>
    </span>
    <template v-if="computerAgent.state !== 'stopped'">
      <button
        v-if="computerAgent.state === 'paused'"
        type="button"
        class="browser-agent-btn primary"
        data-testid="computer-resume"
        :disabled="computerAgent.busy"
        @click="control('resume')"
      >
        {{ $t('computer.resume') }}
      </button>
      <button
        v-else
        type="button"
        class="browser-agent-btn"
        data-testid="computer-pause"
        :disabled="computerAgent.busy"
        @click="control('pause')"
      >
        {{ $t('computer.pause') }}
      </button>
      <button
        type="button"
        class="browser-agent-btn"
        data-testid="computer-stop"
        :disabled="computerAgent.busy"
        @click="control('stop')"
      >
        {{ $t('computer.stop') }}
      </button>
    </template>
  </div>
</template>
