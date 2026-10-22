<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import * as api from '../../api'
import AppIcon from '../AppIcon.vue'
import HumanAvatar from './HumanAvatar.vue'

/**
 * 选同事（多人群聊，契约 §6.10）：同组织在用的账号，不含自己；exclude 里的（已在群里的）不显示。
 * 组织里只有自己一个人时不渲染任何东西（emit available=false），单人 / 本机模式界面不变。
 */
const props = withDefaults(defineProps<{ modelValue: string[]; exclude?: string[]; disabled?: boolean }>(), {
  exclude: () => [],
  disabled: false,
})
const emit = defineEmits<{ 'update:modelValue': [ids: string[]]; available: [value: boolean] }>()

const colleagues = ref<api.Colleague[]>([])
const loaded = ref(false)
const keyword = ref('')

const candidates = computed(() => colleagues.value.filter((user) => !props.exclude.includes(user.id)))
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return candidates.value
  return candidates.value.filter((user) => user.name.toLowerCase().includes(k) || user.email.toLowerCase().includes(k))
})

function toggle(id: string): void {
  if (props.disabled) return
  emit(
    'update:modelValue',
    props.modelValue.includes(id) ? props.modelValue.filter((x) => x !== id) : [...props.modelValue, id],
  )
}

onMounted(async () => {
  colleagues.value = await api.listColleagues().catch(() => [])
  loaded.value = true
  emit('available', colleagues.value.length > 0)
})
</script>

<template>
  <div v-if="loaded && colleagues.length > 0" class="colleague-picker" data-testid="colleague-picker">
    <div class="colleague-head">
      <span class="colleague-label">{{ $t('groupPeople.people') }}</span>
      <span v-if="modelValue.length" class="colleague-count">{{
        $t('groupPeople.selected', [modelValue.length])
      }}</span>
    </div>
    <p v-if="candidates.length === 0" class="colleague-empty">{{ $t('groupPeople.allInvited') }}</p>
    <template v-else>
      <input
        v-if="candidates.length > 5"
        v-model="keyword"
        class="colleague-search"
        type="search"
        :placeholder="$t('groupPeople.searchPlaceholder')"
        :aria-label="$t('groupPeople.searchPlaceholder')"
        :disabled="disabled"
      />
      <div class="colleague-list" role="group" :aria-label="$t('groupPeople.peopleAria')">
        <button
          v-for="user in shown"
          :key="user.id"
          type="button"
          class="context-agent colleague"
          :class="{ checked: modelValue.includes(user.id) }"
          role="menuitemcheckbox"
          :aria-checked="modelValue.includes(user.id)"
          :disabled="disabled"
          :data-user-id="user.id"
          @click="toggle(user.id)"
        >
          <HumanAvatar :user-id="user.id" :name="user.name" :size="28" />
          <span class="context-agent-text">
            <strong>{{ user.name }}</strong>
            <span>{{ user.email }}</span>
          </span>
          <span class="context-check">
            <AppIcon v-if="modelValue.includes(user.id)" name="check" :size="14" />
          </span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.colleague-picker {
  margin: 8px 6px 0;
}
.colleague-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.colleague-label {
  color: var(--text-secondary);
  font-size: 11.5px;
}
.colleague-count {
  color: var(--text-tertiary);
  font-size: 11px;
}
.colleague-empty {
  margin: 4px 2px;
  color: var(--text-tertiary);
  font-size: 12px;
}
.colleague-search {
  width: 100%;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-muted);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.colleague-search:focus-visible {
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.colleague-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 168px;
  overflow-y: auto;
}
.colleague {
  min-height: 42px;
  padding: 6px 8px;
}
</style>
