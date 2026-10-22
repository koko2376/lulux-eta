<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Member, Permission, PermissionOverrides } from '../api'
import { t } from '../i18n'
import { PERMISSION_GROUPS, effectiveAllowed, toggleOverride, type PermissionGroupId } from '../lib/fine-permissions'
import { PERMISSION_LABEL, ROLE_LABEL } from '../lib/session'

/**
 * 成员权限编辑器（团队服务器）：按分组列出可单独授予 / 收回的业务权限。
 * 勾选状态 = 角色默认值 ± 覆盖项；保存时把覆盖项整体交给父组件。
 */
const props = withDefaults(defineProps<{ member: Member; readonly?: boolean; saving?: boolean }>(), {
  readonly: false,
  saving: false,
})
const emit = defineEmits<{ save: [overrides: PermissionOverrides]; cancel: [] }>()

const draft = ref<PermissionOverrides>({ ...(props.member.permissionOverrides ?? {}) })
watch(
  () => props.member,
  (member) => {
    draft.value = { ...(member.permissionOverrides ?? {}) }
  },
)

const isOwner = computed(() => props.member.role === 'owner')
const locked = computed(() => props.readonly || isOwner.value)

const GROUP_LABEL: Record<PermissionGroupId, () => string> = {
  customer: () => t('finePerms.groupCustomer'),
  deal: () => t('finePerms.groupDeal'),
  quote_order: () => t('finePerms.groupQuoteOrder'),
  task: () => t('finePerms.groupTask'),
  data: () => t('finePerms.groupData'),
  email: () => t('finePerms.groupEmail'),
  workflow: () => t('finePerms.groupWorkflow'),
}

function allowed(permission: Permission): boolean {
  return effectiveAllowed(props.member.role, draft.value, permission)
}
function custom(permission: Permission): boolean {
  return !isOwner.value && draft.value[permission] !== undefined
}
/** 删除类、导入客户、管理工作流都要同时有“修改业务数据”：缺少时给出提示 */
const NEEDS_WRITE: Permission[] = [
  'customer:delete',
  'deal:delete',
  'quote:delete',
  'order:delete',
  'task:delete',
  'customer:import',
  'workflow:manage',
]
function needsWrite(permission: Permission): boolean {
  return NEEDS_WRITE.includes(permission) && allowed(permission) && !allowed('data:write')
}
function toggle(permission: Permission, value: boolean): void {
  if (locked.value) return
  draft.value = toggleOverride(props.member.role, draft.value, permission, value)
}
function resetAll(): void {
  draft.value = {}
}
const customCount = computed(() => Object.keys(draft.value).length)
const dirty = computed(() => {
  const before = props.member.permissionOverrides ?? {}
  const keys = new Set([...Object.keys(before), ...Object.keys(draft.value)]) as Set<Permission>
  return [...keys].some((key) => before[key] !== draft.value[key])
})
</script>

<template>
  <div class="perm-editor" data-testid="member-permissions">
    <p class="field-hint">
      {{ isOwner ? $t('finePerms.ownerAll') : $t('finePerms.editorHint', [ROLE_LABEL[member.role]]) }}
    </p>
    <fieldset v-for="group in PERMISSION_GROUPS" :key="group.id" class="perm-group" :data-group="group.id">
      <legend>{{ GROUP_LABEL[group.id]() }}</legend>
      <label v-for="permission in group.permissions" :key="permission" class="perm-row" :data-perm="permission">
        <input
          type="checkbox"
          :checked="allowed(permission)"
          :disabled="locked"
          :aria-describedby="needsWrite(permission) ? `perm-need-${permission}` : undefined"
          @change="toggle(permission, ($event.target as HTMLInputElement).checked)"
        />
        <span class="perm-name">{{ PERMISSION_LABEL[permission] }}</span>
        <span v-if="custom(permission)" class="tag tag-custom" data-testid="perm-custom">{{
          $t('finePerms.custom')
        }}</span>
        <span v-else-if="!isOwner" class="dim small">{{ $t('finePerms.default') }}</span>
        <span v-if="needsWrite(permission)" :id="`perm-need-${permission}`" class="perm-need small">{{
          $t('finePerms.needsWrite')
        }}</span>
      </label>
    </fieldset>
    <div v-if="!locked" class="perm-actions">
      <span class="dim small">{{ customCount ? $t('finePerms.adjustedCount', [customCount]) : '' }}</span>
      <span class="grow" />
      <button type="button" class="kbtn sm ghost" :disabled="!customCount || saving" @click="resetAll">
        {{ $t('finePerms.reset') }}
      </button>
      <button type="button" class="kbtn sm" :disabled="saving" @click="emit('cancel')">
        {{ $t('settingsTeam.kldkknc') }}
      </button>
      <button
        type="button"
        class="kbtn sm primary"
        data-testid="perm-save"
        :disabled="!dirty || saving"
        @click="emit('save', { ...draft })"
      >
        {{ $t('finePerms.save') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.perm-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.perm-group {
  border: 1px solid var(--line, rgba(127, 127, 127, 0.25));
  border-radius: 10px;
  padding: 8px 12px 10px;
  margin: 0;
}
.perm-group legend {
  font-size: 12px;
  font-weight: 600;
  padding: 0 4px;
  color: var(--text-2, inherit);
}
.perm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 0;
  cursor: pointer;
}
.perm-row input:disabled {
  cursor: not-allowed;
}
.perm-name {
  min-width: 0;
}
.tag-custom {
  color: var(--accent, #2563eb);
}
.perm-need {
  flex-basis: 100%;
  padding-left: 24px;
  color: var(--warn, #b45309);
}
.perm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
}
</style>
