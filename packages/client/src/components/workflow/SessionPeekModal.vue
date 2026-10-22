<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getSession, type Message } from '../../api'
import { errorText } from '../../stores/ui'
import MessageContent from '../MessageContent.vue'
import StateBlock from '../ui/StateBlock.vue'
import UiModal from '../ui/UiModal.vue'

/** 工作流节点的隐藏会话（sessions.workflowRunId 非空，不在侧栏里，服务端拒绝在里面发消息）：只读查看完整对话 */
const props = defineProps<{ sessionId: string; title: string }>()
const emit = defineEmits<{ close: [] }>()

const messages = ref<Message[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    messages.value = (await getSession(props.sessionId)).messages.filter((m) => m.role !== 'system')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <UiModal
    :title="$t('workflow.sessionTitle', [title])"
    :subtitle="$t('workflow.sessionSub')"
    :width="680"
    @close="emit('close')"
  >
    <StateBlock v-if="loading" state="loading" compact />
    <StateBlock v-else-if="error" state="error" :message="error" compact @retry="load" />
    <p v-else-if="!messages.length" class="peek-empty">{{ $t('workflow.sessionEmpty') }}</p>
    <div v-else class="peek" data-testid="session-peek">
      <div v-for="m in messages" :key="m.id" class="peek-msg" :class="m.role">
        <div class="peek-role">{{ m.role === 'user' ? $t('workflow.roleInput') : $t('workflow.roleAgent') }}</div>
        <div class="peek-content"><MessageContent :content="m.content" :markdown="m.role === 'assistant'" /></div>
      </div>
    </div>
  </UiModal>
</template>

<style scoped>
.peek {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.peek-msg {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface-soft);
  border: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.6;
}
.peek-msg.user {
  background: var(--surface-muted);
}
.peek-role {
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}
.peek-content {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.peek-msg.assistant .peek-content {
  white-space: normal;
}
.peek-empty {
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
  margin: 24px 0;
}
</style>
