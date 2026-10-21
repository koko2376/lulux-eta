<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Session, SessionParticipant } from '../../api'
import { t } from '../../i18n'
import { canManageGroup, canRemoveMember, humanMembers, isGroupOwner } from '../../lib/group-members'
import { auth } from '../../lib/session'
import { useAppStore } from '../../stores/app'
import { confirmDialog, toast } from '../../stores/ui'
import AppIcon from '../AppIcon.vue'
import ColleaguePicker from './ColleaguePicker.vue'
import HumanAvatar from './HumanAvatar.vue'

/**
 * 群里的同事（契约 §6.10）：成员列表、群主设管理员、群主 / 管理员邀请与移出、普通成员退出群聊。
 * 只在团队服务器模式的群聊里显示；单人 / 本机模式界面不变。
 */
const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ error: [message: string]; left: [] }>()

const store = useAppStore()
const inviting = ref(false)
const picked = ref<string[]>([])
const busy = ref(false)
const hasColleagues = ref(true)

const meId = computed(() => auth.me?.user.id ?? null)
const members = computed(() => humanMembers(props.session))
const manage = computed(() => canManageGroup(props.session))
const owner = computed(() => isGroupOwner(props.session))
const memberIds = computed(() => members.value.map((m) => m.userId))

function roleLabel(member: SessionParticipant): string {
  return member.role === 'owner'
    ? t('groupPeople.owner')
    : member.role === 'admin'
      ? t('groupPeople.admin')
      : t('groupPeople.member')
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await action()
  } catch (value) {
    emit('error', value instanceof Error ? value.message : String(value))
  } finally {
    busy.value = false
  }
}

function invite(): Promise<void> {
  return run(async () => {
    await store.inviteToGroup(props.session.id, picked.value)
    picked.value = []
    inviting.value = false
  })
}

function remove(member: SessionParticipant): Promise<void> {
  return run(() => store.removeFromGroup(props.session.id, member.userId))
}

function toggleAdmin(member: SessionParticipant): Promise<void> {
  return run(() => store.setGroupRole(props.session.id, member.userId, member.role === 'admin' ? 'member' : 'admin'))
}

async function leave(): Promise<void> {
  const ok = await confirmDialog({
    title: t('groupPeople.leaveConfirmTitle'),
    message: t('groupPeople.leaveConfirm'),
    confirmText: t('groupPeople.leave'),
    danger: true,
  })
  if (!ok) return
  await run(async () => {
    await store.leaveGroup(props.session.id)
    toast.success(t('groupPeople.left'))
    emit('left')
  })
}
</script>

<template>
  <section class="group-people" data-testid="group-people">
    <header class="group-people-head">
      <span class="group-people-title">{{ $t('groupPeople.membersTitle') }}</span>
      <span class="group-people-count">{{ $t('groupPeople.count', [members.length]) }}</span>
    </header>
    <ul class="group-people-list">
      <li v-for="member in members" :key="member.userId" class="group-person" :data-user-id="member.userId">
        <HumanAvatar :user-id="member.userId" :name="member.name" :size="26" />
        <span class="group-person-name"
          >{{ member.name
          }}<span v-if="member.userId === meId" class="group-person-me">{{
            $t('fmt.parenOnly', [$t('groupPeople.me')])
          }}</span></span
        >
        <span class="group-person-role" :class="member.role">{{ roleLabel(member) }}</span>
        <button
          v-if="owner && member.role !== 'owner'"
          type="button"
          class="group-person-action"
          :title="member.role === 'admin' ? $t('groupPeople.unsetAdmin') : $t('groupPeople.makeAdmin')"
          :aria-label="member.role === 'admin' ? $t('groupPeople.unsetAdmin') : $t('groupPeople.makeAdmin')"
          :disabled="busy"
          @click="toggleAdmin(member)"
        >
          <AppIcon name="shield" :size="13" />
        </button>
        <button
          v-if="canRemoveMember(session, member, meId)"
          type="button"
          class="group-person-action danger"
          :title="$t('groupPeople.removeTitle', [member.name])"
          :aria-label="$t('groupPeople.removeTitle', [member.name])"
          :disabled="busy"
          @click="remove(member)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </li>
    </ul>

    <template v-if="manage && hasColleagues">
      <button
        v-if="!inviting"
        type="button"
        class="group-people-invite"
        data-testid="group-invite"
        :disabled="busy"
        @click="inviting = true"
      >
        <AppIcon name="plus" :size="13" />
        <span>{{ $t('groupPeople.invite') }}</span>
      </button>
      <div v-else class="group-people-picker">
        <ColleaguePicker
          v-model="picked"
          :exclude="memberIds"
          :disabled="busy"
          @available="(value) => (hasColleagues = value)"
        />
        <div class="group-people-picker-foot">
          <button
            type="button"
            class="context-export"
            @click="
              () => {
                inviting = false
                picked = []
              }
            "
          >
            {{ $t('newGroup.cancel') }}
          </button>
          <button type="button" class="context-done" :disabled="busy || picked.length === 0" @click="invite">
            {{ $t('groupPeople.inviteConfirm') }}
          </button>
        </div>
      </div>
    </template>
    <p v-else-if="!manage" class="group-people-hint">{{ $t('groupPeople.managedHint') }}</p>

    <button
      v-if="!owner"
      type="button"
      class="group-people-leave"
      data-testid="group-leave"
      :disabled="busy"
      @click="leave"
    >
      <AppIcon name="external" :size="13" />
      <span>{{ $t('groupPeople.leave') }}</span>
    </button>
  </section>
</template>

<style scoped>
.group-people {
  margin: 8px 6px 0;
  padding: 8px 0 2px;
  border-top: 1px solid var(--border-subtle, var(--surface-muted));
}
.group-people-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 2px 4px;
}
.group-people-title {
  color: var(--text-secondary);
  font-size: 11.5px;
}
.group-people-count {
  color: var(--text-tertiary);
  font-size: 11px;
}
.group-people-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.group-person {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 3px 4px;
  border-radius: 8px;
}
.group-person:hover {
  background: var(--surface-hover);
}
.group-person-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-person-me {
  color: var(--text-tertiary);
  font-weight: 400;
}
.group-person-role {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 10.5px;
}
.group-person-role.owner {
  background: var(--text);
  color: var(--window);
}
.group-person-action {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.group-person-action:hover:not(:disabled) {
  background: var(--surface-muted);
  color: var(--text);
}
.group-person-action.danger:hover:not(:disabled) {
  color: var(--danger, #d1453b);
}
.group-people-invite,
.group-people-leave {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 6px 2px 0;
  padding: 5px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.group-people-invite:hover:not(:disabled),
.group-people-leave:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}
.group-people-leave {
  color: var(--danger, #d1453b);
}
.group-people-picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.group-people-hint {
  margin: 6px 2px 0;
  color: var(--text-tertiary);
  font-size: 11.5px;
}
</style>
