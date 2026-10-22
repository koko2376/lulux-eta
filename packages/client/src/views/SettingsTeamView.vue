<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import * as api from '../api'
import MemberPermissionsEditor from '../components/MemberPermissionsEditor.vue'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiPager from '../components/ui/UiPager.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { formatDate, relativeTime } from '../lib/labels'
import { ROLE_LABEL, auth, can, currentRole, currentUser, denyReason, initAuth } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { intlLocale, t } from '../i18n'
import { PERMISSION_LEVELS, isPermissionLevel, type PermissionLevel } from '../lib/permissions'

const isServer = computed(() => auth.mode === 'server')
const manage = computed(() => can('members:manage'))
type Tab = 'members' | 'invites' | 'teams' | 'security' | 'audit'
const tab = ref<Tab>(isServer.value ? 'members' : 'audit')
const TABS = computed(
  () =>
    [
      { k: 'members', l: t('settingsTeam.k1ht4tfl'), show: isServer.value },
      { k: 'invites', l: t('settingsTeam.kh36knj'), show: isServer.value && manage.value },
      { k: 'teams', l: t('settingsTeam.k9e0mjz'), show: isServer.value },
      { k: 'security', l: t('settingsTeam.k177bhuv'), show: isServer.value },
      {
        k: 'audit',
        l: isServer.value ? t('settingsTeam.kwuohmr') : t('settingsTeam.k1oikyu8'),
        show: can('audit:read'),
      },
    ].filter((t) => t.show) as Array<{ k: Tab; l: string }>,
)

/* ── 组织 / 成员 ── */
const members = ref<api.Member[]>([])
const teams = ref<api.Team[]>([])
const loading = ref(false)
const loadError = ref('')
const orgName = ref(auth.me?.org.name ?? '')

async function load(): Promise<void> {
  if (!isServer.value) return
  loading.value = true
  loadError.value = ''
  try {
    ;[members.value, teams.value] = await Promise.all([api.listMembers(), api.listTeams()])
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  if (tab.value === 'audit') void loadAudit()
})

async function saveOrg(): Promise<void> {
  if (!orgName.value.trim()) return
  await api.updateOrg(orgName.value.trim())
  await initAuth(true)
  toast.success(t('settingsTeam.kg9u66m'))
}

const meId = computed(() => currentUser.value?.id)
/** admin 不能动 owner、不能授予 owner；不能改自己 */
function canEditMember(u: api.User): boolean {
  if (!manage.value || u.id === meId.value) return false
  if (u.role === 'owner' && currentRole.value !== 'owner') return false
  return true
}
const roleOptions = computed<api.Role[]>(() =>
  currentRole.value === 'owner' ? ['admin', 'member', 'viewer'] : ['admin', 'member', 'viewer'],
)

async function changeRole(u: api.User, role: api.Role): Promise<void> {
  if (role === u.role) return
  const ok = await confirmDialog({
    title: t('settingsTeam.k1o8zn6y', [u.name, ROLE_LABEL[role]]),
    message: role === 'viewer' ? t('settingsTeam.k1y77iv3') : t('settingsTeam.k1soazle'),
    confirmText: t('settingsTeam.k1991pug'),
  })
  if (!ok) return void (members.value = [...members.value])
  const updated = await api.updateMember(u.id, { role })
  Object.assign(u, updated)
  toast.success(t('settingsTeam.kyto6ea'))
}
async function toggleDisabled(u: api.User): Promise<void> {
  const disabling = !u.disabled
  if (
    disabling &&
    !(await confirmDialog({
      title: t('settingsTeam.kqryxr4', [u.name]),
      message: t('teamLifecycle.disableMessage'),
      confirmText: t('settingsTeam.k1ocxl5d'),
      danger: true,
    }))
  )
    return
  Object.assign(u, await api.updateMember(u.id, { disabled: disabling }))
  toast.success(disabling ? t('settingsTeam.ku3ouk7') : t('settingsTeam.ktlfasy'))
}

/* 细粒度权限：owner 恒为全部；只有 owner 能调整管理员 */
const permEditing = ref<api.Member | null>(null)
const permSaving = ref(false)
function canEditPermissions(u: api.Member): boolean {
  if (!canEditMember(u) || u.role === 'owner') return false
  return u.role !== 'admin' || currentRole.value === 'owner'
}
function customPermCount(u: api.Member): number {
  return Object.keys(u.permissionOverrides ?? {}).length
}
async function savePermissions(overrides: api.PermissionOverrides): Promise<void> {
  const target = permEditing.value
  if (!target) return
  permSaving.value = true
  try {
    const updated = await api.setMemberPermissions(target.id, overrides)
    const row = members.value.find((m) => m.id === target.id)
    if (row) Object.assign(row, updated)
    toast.success(t('finePerms.saved', [target.name]))
    permEditing.value = null
  } finally {
    permSaving.value = false
  }
}

/* 重置密码 */
const resetting = ref<api.User | null>(null)
const resetPwd = ref('')
const resetError = ref('')
function openReset(u: api.User): void {
  resetting.value = u
  resetPwd.value = ''
  resetError.value = ''
}
function genPassword(): void {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const buf = new Uint32Array(14)
  crypto.getRandomValues(buf)
  resetPwd.value = Array.from(buf, (n) => chars[n % chars.length]).join('')
}
function genCreatePassword(): void {
  createForm.password = randomPassword()
}
async function submitReset(): Promise<void> {
  if (!resetting.value) return
  if (resetPwd.value.length < 8) return void (resetError.value = t('settingsTeam.ksrklc5'))
  try {
    await api.resetMemberPassword(resetting.value.id, resetPwd.value)
    toast.success(t('settingsTeam.kxl454l', [resetting.value.name]))
    resetting.value = null
  } catch (error) {
    resetError.value =
      error instanceof api.ApiError && error.code === 'WEAK_PASSWORD' ? t('settingsTeam.kr05pd5') : errorText(error)
  }
}

/* 离职交接（客户及其业务记录、邮箱账户、工作流、定时任务） / 转让所有权 */
const handover = ref<api.User | null>(null)
const handoverTo = ref('')
const handoverCounts = ref<api.HandoverCounts | null>(null)
const handoverLoading = ref(false)
const handoverBusy = ref(false)
const handoverOpts = reactive({ emailAccounts: 'transfer' as api.HandoverEmailMode, workflows: true, schedules: true })
const HANDOVER_TYPES = [
  'customers',
  'quotes',
  'deals',
  'orders',
  'tasks',
  'emailAccounts',
  'workflows',
  'schedules',
] as const
const handoverReceivers = computed(() => members.value.filter((x) => x.id !== handover.value?.id && !x.disabled))
async function openHandover(u: api.User): Promise<void> {
  handover.value = u
  handoverTo.value = ''
  handoverCounts.value = null
  Object.assign(handoverOpts, { emailAccounts: 'transfer', workflows: true, schedules: true })
  handoverLoading.value = true
  try {
    handoverCounts.value = await api.getHandoverPreview(u.id)
  } catch {
    // 旧服务端没有预览接口：只能交接客户，照旧可用
    handoverCounts.value = null
  } finally {
    handoverLoading.value = false
  }
}
/** 定时任务可能以工作流为目标：转定时任务时工作流必须一起转 */
const handoverSchedules = computed({
  get: () => handoverOpts.schedules,
  set(on: boolean) {
    handoverOpts.schedules = on
    if (on) handoverOpts.workflows = true
  },
})
const handoverWorkflows = computed({
  get: () => handoverOpts.workflows,
  set(on: boolean) {
    handoverOpts.workflows = on
    if (!on) handoverOpts.schedules = false
  },
})
async function submitHandover(): Promise<void> {
  if (!handover.value || !handoverTo.value || handoverBusy.value) return
  handoverBusy.value = true
  try {
    const res = await api.transferCustomers(
      handover.value.id,
      handoverTo.value,
      handoverCounts.value ? { ...handoverOpts } : {},
    )
    const parts = [t('teamLifecycle.doneCustomers', [res.moved])]
    if (res.emailAccounts?.count) {
      parts.push(
        res.emailAccounts.mode === 'transfer'
          ? t('teamLifecycle.doneEmailTransfer', [res.emailAccounts.count])
          : t('teamLifecycle.doneEmailDisable', [res.emailAccounts.count]),
      )
    }
    if (res.workflows) parts.push(t('teamLifecycle.doneWorkflows', [res.workflows]))
    if (res.schedules) parts.push(t('teamLifecycle.doneSchedules', [res.schedules]))
    toast.success(parts.join(t('teamLifecycle.joiner')))
    handover.value = null
  } finally {
    handoverBusy.value = false
  }
}
async function transferOwner(u: api.User): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsTeam.kik1nf9', [u.name]),
    message: t('settingsTeam.kci2r6y'),
    confirmText: t('settingsTeam.kctzuie'),
    danger: true,
    typeToConfirm: u.email,
  })
  if (!ok) return
  await api.transferOwnership(u.id)
  await initAuth(true)
  await load()
  toast.success(t('settingsTeam.k5wyra9'))
}

/* 直接添加成员（管理员设初始密码，对方首次登录须修改） */
const showCreate = ref(false)
const createForm = reactive({
  email: '',
  name: '',
  role: 'member' as Exclude<api.Role, 'owner'>,
  teamId: '',
  password: '',
})
const createError = ref('')
const createBusy = ref(false)
function openCreate(): void {
  Object.assign(createForm, { email: '', name: '', role: 'member', teamId: '', password: '' })
  createError.value = ''
  showCreate.value = true
}
function randomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const buf = new Uint32Array(14)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join('')
}
async function submitCreate(): Promise<void> {
  createError.value = ''
  if (!createForm.email.trim() || !createForm.name.trim())
    return void (createError.value = t('teamLifecycle.createRequired'))
  if (createForm.password.length < 8) return void (createError.value = t('settingsTeam.ksrklc5'))
  createBusy.value = true
  try {
    const member = await api.createMember({
      email: createForm.email.trim(),
      name: createForm.name.trim(),
      role: createForm.role,
      password: createForm.password,
      teamId: createForm.teamId || undefined,
    })
    members.value = [...members.value, member]
    toast.success(t('teamLifecycle.created', [member.name]))
    showCreate.value = false
  } catch (error) {
    createError.value =
      error instanceof api.ApiError && error.code === 'EMAIL_TAKEN'
        ? t('teamLifecycle.emailTaken')
        : error instanceof api.ApiError && error.code === 'WEAK_PASSWORD'
          ? t('settingsTeam.kr05pd5')
          : errorText(error)
  } finally {
    createBusy.value = false
  }
}

/* ── 邀请 ── */
const invites = ref<api.Invite[]>([])
const inviteForm = reactive({
  role: 'member' as api.Invite['role'],
  email: '',
  teamId: '',
  expiresInHours: 72,
  maxUses: 1,
})
const showInvite = ref(false)
const created = ref<{ code: string; url: string; invite: api.Invite } | null>(null)
async function loadInvites(): Promise<void> {
  invites.value = await api.listInvites().catch(() => [])
}
async function submitInvite(): Promise<void> {
  created.value = await api.createInvite({
    role: inviteForm.role,
    email: inviteForm.email.trim() || undefined,
    teamId: inviteForm.teamId || undefined,
    expiresInHours: Number(inviteForm.expiresInHours) || 72,
    maxUses: Number(inviteForm.maxUses) || 1,
  })
  showInvite.value = false
  await loadInvites()
}
async function revoke(inv: api.Invite): Promise<void> {
  if (
    !(await confirmDialog({
      title: t('settingsTeam.kgr8xxr'),
      message: t('settingsTeam.k60bjgq'),
      confirmText: t('settingsTeam.k18ca6x9'),
      danger: true,
    }))
  )
    return
  await api.revokeInvite(inv.id)
  await loadInvites()
}
function inviteState(inv: api.Invite): { text: string; cls: string } {
  if (inv.revoked) return { text: t('settingsTeam.kqx5dbc'), cls: 'badge-off' }
  if (inv.uses >= inv.maxUses) return { text: t('settingsTeam.k157rn5i'), cls: 'badge-off' }
  if (inv.expiresAt < Date.now()) return { text: t('settingsTeam.k5d2kwf'), cls: 'badge-off' }
  return { text: t('settingsTeam.k1c28xfc'), cls: 'badge-on' }
}
function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(t('settingsTeam.k1r4hxti')),
    () => toast.error(t('settingsTeam.kbgnfhe')),
  )
}

/* ── 团队 ── */
const teamForm = reactive({ id: '', name: '', memberIds: [] as string[] })
const showTeam = ref(false)
function openTeam(t?: api.Team): void {
  Object.assign(teamForm, { id: t?.id ?? '', name: t?.name ?? '', memberIds: [...(t?.memberIds ?? [])] })
  showTeam.value = true
}
async function submitTeam(): Promise<void> {
  if (!teamForm.name.trim()) return
  const body = { name: teamForm.name.trim(), memberIds: teamForm.memberIds }
  if (teamForm.id) await api.updateTeam(teamForm.id, body)
  else await api.createTeam(body)
  showTeam.value = false
  teams.value = await api.listTeams()
}
async function removeTeam(team: api.Team): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsTeam.k1l19v0', [team.name]),
    message: t('settingsTeam.k1cmk0mh'),
    confirmText: t('settingsTeam.k191ahec'),
    danger: true,
  })
  if (!ok) return
  await api.deleteTeam(team.id)
  teams.value = await api.listTeams()
}
const memberName = (id: string | null) => members.value.find((m) => m.id === id)?.name ?? '—'

/* ── 内核与 MCP ── */
const security = ref<api.SecuritySettings | null>(null)
async function loadSecurity(): Promise<void> {
  security.value = await api.getSecurity({ silent: true }).catch(() => null)
  if (manage.value) void loadCaps()
}

/* ── 成员权限上限（契约 §6.11） ── */
const caps = ref<api.PermissionCaps | null>(null)
const CAP_ROLES = ['admin', 'member', 'viewer'] as const
const capRoleLabel = (role: (typeof CAP_ROLES)[number]): string =>
  t(role === 'admin' ? 'permission.roleAdmin' : role === 'member' ? 'permission.roleMember' : 'permission.roleViewer')
async function loadCaps(): Promise<void> {
  caps.value = await api.getPermissionCaps().catch(() => null)
}
async function setRoleCap(role: (typeof CAP_ROLES)[number], level: PermissionLevel): Promise<void> {
  caps.value = await api.updatePermissionCaps({ roles: { [role]: level } })
  toast.success(t('permission.capsSaved'))
}
async function setMemberCap(userId: string, value: string): Promise<void> {
  caps.value = await api.updatePermissionCaps({ members: { [userId]: isPermissionLevel(value) ? value : null } })
  toast.success(t('permission.capsSaved'))
}
async function setSecurity(key: 'allowKernels' | 'allowMcp', on: boolean): Promise<void> {
  if (!security.value) return
  if (on) {
    const ok = await confirmDialog({
      title: key === 'allowKernels' ? t('settingsTeam.kyp3zpb') : t('settingsTeam.k5f3syz'),
      message: security.value.warning,
      confirmText: t('settingsTeam.k1fu1my7'),
      danger: true,
      typeToConfirm: t('settingsTeam.kadmdo7'),
    })
    if (!ok) return
  }
  security.value = await api.updateSecurity({ [key]: on, ...(on ? { confirm: 'I_UNDERSTAND' as const } : {}) })
  toast.success(on ? t('settingsTeam.k1nt2knb') : t('settingsTeam.k1wasy6z'))
}

async function setAdminMailboxAccess(on: boolean): Promise<void> {
  if (!security.value) return
  if (on) {
    const ok = await confirmDialog({
      title: t('settingsTeam.adminMailboxTitle'),
      message: t('settingsTeam.adminMailboxConfirm'),
      confirmText: t('settingsTeam.k1fu1my7'),
      danger: true,
    })
    if (!ok) return
  }
  security.value = await api.updateSecurity({ adminMailboxAccess: on })
  toast.success(on ? t('settingsTeam.k1nt2knb') : t('settingsTeam.k1wasy6z'))
}

/* ── 审计 ── */
const audit = ref<api.AuditEntry[]>([])
const auditTotal = ref(0)
const auditLoading = ref(false)
const auditError = ref('')
const filters = reactive({ userId: '', action: '', entityType: '', from: '', to: '', page: 1 })
const ACTION_PRESETS = [
  { v: '', l: t('settingsTeam.k8hk0vj') },
  { v: 'auth.', l: t('settingsTeam.k15siuy5') },
  { v: 'member.', l: t('settingsTeam.k1ht4tfl') },
  { v: 'invite.', l: t('settingsTeam.kh36knj') },
  { v: 'customer.', l: t('settingsTeam.k1v5iwp2') },
  { v: 'quote.', l: t('settingsTeam.kxbx0dt') },
  { v: 'email', l: t('settingsTeam.k13xrrc4') },
  { v: 'email.admin.', l: t('settingsTeam.auditAdminMailbox') },
  { v: 'data.', l: t('settingsTeam.k1hitbg5') },
  { v: 'backup.', l: t('settingsTeam.auditBackup') },
  { v: 'provider.', l: t('settingsTeam.k1cy9ozw') },
  { v: 'security.', l: t('settingsTeam.k12tylew') },
  { v: 'settings.', l: t('settingsTeam.kyxspmz') },
  { v: 'mcp.', l: 'MCP' },
  { v: 'kernel.', l: t('settingsTeam.k13pd4cx') },
]
async function loadAudit(): Promise<void> {
  auditLoading.value = true
  auditError.value = ''
  try {
    const dayStart = (s: string) => (s ? new Date(`${s}T00:00:00`).getTime() : undefined)
    const res = await api.listAudit({
      userId: filters.userId || undefined,
      action: filters.action || undefined,
      entityType: filters.entityType || undefined,
      from: dayStart(filters.from),
      to: filters.to ? (dayStart(filters.to) as number) + 86_400_000 - 1 : undefined,
      page: filters.page,
      pageSize: 30,
    })
    audit.value = res.items
    auditTotal.value = res.total
  } catch (error) {
    auditError.value = errorText(error)
  } finally {
    auditLoading.value = false
  }
}
watch(
  () => [filters.userId, filters.action, filters.entityType, filters.from, filters.to],
  () => {
    filters.page = 1
    void loadAudit()
  },
)
watch(() => filters.page, loadAudit)
watch(tab, (t) => {
  if (t === 'invites') void loadInvites()
  if (t === 'security') void loadSecurity()
  if (t === 'audit') void loadAudit()
})
const fmtTime = (ms: number) => new Date(ms).toLocaleString(intlLocale(), { hour12: false })
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar
      :title="$t('settingsTeam.kin6nky')"
      :sub="
        isServer
          ? $t('settingsTeam.kfk5e4y', [auth.me?.org.name ?? '', ROLE_LABEL[currentRole]])
          : $t('settingsTeam.kozwdtn')
      "
    >
      <button
        v-if="isServer && tab === 'invites'"
        type="button"
        class="kbtn primary"
        data-testid="new-invite"
        @click="showInvite = true"
      >
        {{ $t('settingsTeam.kfj4abr') }}
      </button>
      <button
        v-if="isServer && tab === 'members' && manage"
        type="button"
        class="kbtn primary"
        data-testid="new-member"
        @click="openCreate"
      >
        {{ $t('teamLifecycle.createTitle') }}
      </button>
      <button v-if="isServer && tab === 'teams' && manage" type="button" class="kbtn primary" @click="openTeam()">
        {{ $t('settingsTeam.k14ohq40') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <section v-if="!isServer" class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsTeam.kd8wfkj') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsTeam.kabd2n5') }}
              </div>
            </div>
            <RouterLink class="kbtn" to="/login">{{ $t('settingsTeam.kdxozb2') }}</RouterLink>
          </div>
        </section>

        <div v-if="TABS.length > 1" class="segmented tabs" role="tablist" :aria-label="$t('settingsTeam.k97dr9s')">
          <button
            v-for="it in TABS"
            :key="it.k"
            type="button"
            role="tab"
            :aria-selected="tab === it.k"
            :class="{ on: tab === it.k }"
            @click="tab = it.k"
          >
            {{ it.l }}
          </button>
        </div>

        <!-- 成员 -->
        <template v-if="isServer && tab === 'members'">
          <section v-if="can('settings:write')" class="panel">
            <div class="panel-body hstack">
              <label class="field" style="flex: 1; min-width: 220px">
                <span class="field-label">{{ $t('settingsTeam.ku0fhaj') }}</span>
                <input v-model="orgName" class="input" />
              </label>
              <button type="button" class="kbtn" style="margin-top: 18px" @click="saveOrg">
                {{ $t('settingsTeam.k1xlvxln') }}
              </button>
            </div>
          </section>
          <StateBlock v-if="loading" state="loading" />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
          <div v-else class="table-scroll">
            <table class="data-table" :aria-label="$t('settingsTeam.k1ht4tfl')">
              <thead>
                <tr>
                  <th>{{ $t('settingsTeam.k1ht4tfl') }}</th>
                  <th>{{ $t('settingsTeam.ktqaice') }}</th>
                  <th>{{ $t('settingsTeam.krfzxye') }}</th>
                  <th>{{ $t('settingsTeam.k1orhhsz') }}</th>
                  <th v-if="manage" class="num">{{ $t('settingsTeam.k1voemgk') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in members" :key="u.id" data-testid="member-row">
                  <td>
                    <div class="who">
                      <b>{{ u.name }}</b
                      ><span v-if="u.id === meId" class="tag">{{ $t('settingsTeam.knwxime') }}</span>
                    </div>
                    <div class="dim small">{{ u.email }}</div>
                  </td>
                  <td>
                    <select
                      v-if="canEditMember(u) && u.role !== 'owner'"
                      class="select role"
                      :aria-label="$t('settingsTeam.k1ppg0m8', [u.name])"
                      :value="u.role"
                      @change="changeRole(u, ($event.target as HTMLSelectElement).value as api.Role)"
                    >
                      <option v-for="r in roleOptions" :key="r" :value="r">{{ ROLE_LABEL[r] }}</option>
                    </select>
                    <span v-else class="tag">{{ ROLE_LABEL[u.role] }}</span>
                  </td>
                  <td>
                    <span :class="u.disabled ? 'badge-bad' : 'badge-on'">{{
                      u.disabled ? $t('settingsTeam.ku3ouk7') : $t('settingsTeam.k1wopsai')
                    }}</span>
                    <span v-if="u.mustChangePassword && !u.disabled" class="tag" data-testid="must-change-tag">{{
                      $t('teamLifecycle.mustChangeTag')
                    }}</span>
                  </td>
                  <td class="dim">{{ u.lastLoginAt ? relativeTime(u.lastLoginAt) : $t('settingsTeam.k180sbtz') }}</td>
                  <td v-if="manage" class="num">
                    <div v-if="canEditMember(u)" class="row-actions">
                      <button
                        v-if="canEditPermissions(u)"
                        type="button"
                        class="kbtn sm"
                        data-testid="member-perms-btn"
                        @click="permEditing = u"
                      >
                        {{ $t('finePerms.open')
                        }}<span v-if="customPermCount(u)" class="perm-count">{{ customPermCount(u) }}</span>
                      </button>
                      <button type="button" class="kbtn sm" @click="openReset(u)">
                        {{ $t('settingsTeam.kz15q9y') }}
                      </button>
                      <button type="button" class="kbtn sm" data-testid="member-handover-btn" @click="openHandover(u)">
                        {{ $t('teamLifecycle.handoverButton') }}
                      </button>
                      <button type="button" class="kbtn sm" :class="{ danger: !u.disabled }" @click="toggleDisabled(u)">
                        {{ u.disabled ? $t('settingsTeam.kxp6kyp') : $t('settingsTeam.k1ocxl5d') }}
                      </button>
                      <button
                        v-if="currentRole === 'owner' && !u.disabled"
                        type="button"
                        class="kbtn sm ghost"
                        @click="transferOwner(u)"
                      >
                        {{ $t('settingsTeam.kctzuie') }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="field-hint perm-hint">
            {{ $t('settingsTeam.kdjnuqf') }}
          </p>
        </template>

        <!-- 邀请 -->
        <template v-if="isServer && tab === 'invites'">
          <section class="panel">
            <StateBlock
              v-if="!invites.length"
              state="empty"
              :title="$t('settingsTeam.kaaemhy')"
              :message="$t('settingsTeam.k1jbu71q')"
              compact
            />
            <div v-for="inv in invites" :key="inv.id" class="row-item" data-testid="invite-row">
              <div class="grow">
                <div class="t">
                  {{ inv.email || $t('settingsTeam.k1ej2dhl') }}
                  <span class="tag">{{ ROLE_LABEL[inv.role] }}</span>
                  <span :class="inviteState(inv).cls">{{ inviteState(inv).text }}</span>
                </div>
                <div class="d">
                  {{ $t('settingsTeam.k1w6jug6', [inv.uses, inv.maxUses, fmtTime(inv.expiresAt)]) }}
                  <template v-if="inv.teamId">
                    {{ $t('settingsTeam.km8q84c', [teams.find((t) => t.id === inv.teamId)?.name]) }}</template
                  >
                  {{ $t('settingsTeam.k1f473l7', [memberName(inv.createdBy)]) }}
                </div>
              </div>
              <button
                v-if="inviteState(inv).cls === 'badge-on'"
                type="button"
                class="kbtn sm danger"
                @click="revoke(inv)"
              >
                {{ $t('settingsTeam.k18ca6x9') }}
              </button>
            </div>
          </section>
        </template>

        <!-- 团队 -->
        <template v-if="isServer && tab === 'teams'">
          <section class="panel">
            <StateBlock
              v-if="!teams.length"
              state="empty"
              :title="$t('settingsTeam.k1n0p83b')"
              :message="$t('settingsTeam.k1nwpq4r')"
              compact
            />
            <div v-for="it in teams" :key="it.id" class="row-item">
              <div class="grow">
                <div class="t">
                  {{ it.name }} <span class="tag">{{ $t('settingsTeam.kcbjr2t', [it.memberIds.length]) }}</span>
                </div>
                <div class="d">
                  {{ it.memberIds.map(memberName).join($t('fmt.listSep')) || $t('settingsTeam.k1m2kzy7') }}
                </div>
              </div>
              <template v-if="manage">
                <button type="button" class="kbtn sm" @click="openTeam(it)">{{ $t('settingsTeam.k1alsnuo') }}</button>
                <button type="button" class="kbtn sm danger" @click="removeTeam(it)">
                  {{ $t('settingsTeam.kfcqesv') }}
                </button>
              </template>
            </div>
          </section>
        </template>

        <!-- 内核与 MCP -->
        <template v-if="isServer && tab === 'security'">
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsTeam.k1foxsqq') }}</h2>
                <div class="panel-sub">{{ $t('settingsTeam.k133qcc2') }}</div>
              </div>
            </div>
            <div v-if="security" class="panel-body stack">
              <div class="note warn" role="note">{{ security.warning }}</div>
              <div class="row-item">
                <div class="grow">
                  <div class="t">{{ $t('settingsTeam.k1ld9sy3') }}</div>
                  <div class="d">{{ $t('settingsTeam.k6y3aer') }}</div>
                </div>
                <UiSwitch
                  :label="$t('settingsTeam.k16hbvse')"
                  :model-value="security.allowKernels"
                  :disabled="!can('security:manage')"
                  @update:model-value="setSecurity('allowKernels', $event)"
                />
              </div>
              <div class="row-item">
                <div class="grow">
                  <div class="t">{{ $t('settingsTeam.k1x1erwq') }}</div>
                  <div class="d">{{ $t('settingsTeam.k79penq') }}</div>
                </div>
                <UiSwitch
                  :label="$t('settingsTeam.kabvyx9')"
                  :model-value="security.allowMcp"
                  :disabled="!can('security:manage')"
                  @update:model-value="setSecurity('allowMcp', $event)"
                />
              </div>
              <div class="row-item" data-testid="admin-mailbox-access">
                <div class="grow">
                  <div class="t">{{ $t('settingsTeam.adminMailboxTitle') }}</div>
                  <div class="d">{{ $t('settingsTeam.adminMailboxDesc') }}</div>
                </div>
                <UiSwitch
                  :label="$t('settingsTeam.adminMailboxTitle')"
                  :model-value="!!security.adminMailboxAccess"
                  :disabled="!can('security:manage')"
                  @update:model-value="setAdminMailboxAccess($event)"
                />
              </div>
              <p v-if="!can('security:manage')" class="field-hint">{{ denyReason('security:manage') }}</p>
            </div>
            <StateBlock v-else state="loading" compact />
          </section>
          <section v-if="manage && caps" class="panel" data-testid="permission-caps">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('permission.capsTitle') }}</h2>
                <div class="panel-sub">{{ $t('permission.capsSub') }}</div>
              </div>
            </div>
            <div class="panel-body stack">
              <div class="t">{{ $t('permission.capsRole') }}</div>
              <div v-for="role in CAP_ROLES" :key="role" class="row-item">
                <div class="grow">
                  <div class="t">{{ capRoleLabel(role) }}</div>
                </div>
                <select
                  class="select role"
                  :aria-label="capRoleLabel(role)"
                  :value="caps.roles[role]"
                  :data-role="role"
                  @change="setRoleCap(role, ($event.target as HTMLSelectElement).value as PermissionLevel)"
                >
                  <option v-for="level in PERMISSION_LEVELS" :key="level" :value="level">
                    {{ $t(`permission.${level}`) }}
                  </option>
                </select>
              </div>
              <div class="t">{{ $t('permission.capsMember') }}</div>
              <div v-for="u in members.filter((m) => m.role !== 'owner' && !m.disabled)" :key="u.id" class="row-item">
                <div class="grow">
                  <div class="t">{{ u.name }}</div>
                  <div class="d">{{ ROLE_LABEL[u.role] }} · {{ u.email }}</div>
                </div>
                <select
                  class="select role"
                  :aria-label="u.name"
                  :value="caps.members[u.id] ?? ''"
                  :data-member="u.id"
                  @change="setMemberCap(u.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ $t('permission.capsInherit') }}</option>
                  <option v-for="level in PERMISSION_LEVELS" :key="level" :value="level">
                    {{ $t(`permission.${level}`) }}
                  </option>
                </select>
              </div>
            </div>
          </section>
        </template>

        <!-- 审计 -->
        <template v-if="tab === 'audit' && can('audit:read')">
          <div class="audit-filters">
            <select v-if="isServer" v-model="filters.userId" class="select" :aria-label="$t('settingsTeam.kp35vkr')">
              <option value="">{{ $t('settingsTeam.k15n85al') }}</option>
              <option v-for="m in members" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
            <select v-model="filters.action" class="select" :aria-label="$t('settingsTeam.k1wwtp2p')">
              <option v-for="a in ACTION_PRESETS" :key="a.v" :value="a.v">{{ a.l }}</option>
            </select>
            <select v-model="filters.entityType" class="select" :aria-label="$t('settingsTeam.kus53os')">
              <option value="">{{ $t('settingsTeam.k1cse7a2') }}</option>
              <option value="customer">{{ $t('settingsTeam.k1v5iwp2') }}</option>
              <option value="quote">{{ $t('settingsTeam.kxbx0dt') }}</option>
              <option value="email_account">{{ $t('settingsTeam.k1s375tk') }}</option>
              <option value="email_draft">{{ $t('settingsTeam.k7x8h8h') }}</option>
              <option value="user">{{ $t('settingsTeam.k1ht4tfl') }}</option>
              <option value="invite">{{ $t('settingsTeam.kh36knj') }}</option>
              <option value="provider">{{ $t('settingsTeam.k16g5qd9') }}</option>
            </select>
            <label class="hstack date"
              ><span class="field-label">{{ $t('settingsTeam.k12hohhy') }}</span
              ><input v-model="filters.from" class="input" type="date"
            /></label>
            <label class="hstack date"
              ><span class="field-label">{{ $t('settingsTeam.kxmcbce') }}</span
              ><input v-model="filters.to" class="input" type="date"
            /></label>
          </div>
          <StateBlock v-if="auditLoading && !audit.length" state="loading" />
          <StateBlock v-else-if="auditError" state="error" :message="auditError" @retry="loadAudit" />
          <StateBlock v-else-if="!audit.length" state="empty" :title="$t('settingsTeam.k6yeg3p')" />
          <template v-else>
            <div class="table-scroll">
              <table class="data-table" :aria-label="$t('settingsTeam.kwuohmr')">
                <thead>
                  <tr>
                    <th>{{ $t('settingsTeam.k127i5b7') }}</th>
                    <th>{{ $t('settingsTeam.k1t55vf') }}</th>
                    <th>{{ $t('settingsTeam.k1voemgk') }}</th>
                    <th>{{ $t('settingsTeam.k661u35') }}</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="e in audit" :key="e.id" data-testid="audit-row">
                    <td class="dim nowrap">{{ fmtTime(e.at) }}</td>
                    <td class="nowrap">{{ e.userName || '—' }}</td>
                    <td>
                      <code class="code">{{ e.action }}</code>
                    </td>
                    <td class="summary">{{ e.summary }}</td>
                    <td class="dim nowrap">{{ e.ip }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <UiPager v-model:page="filters.page" :page-size="30" :total="auditTotal" />
          </template>
        </template>
        <StateBlock
          v-if="tab === 'audit' && !can('audit:read')"
          state="empty"
          :title="$t('settingsTeam.knpob1r')"
          :message="denyReason('audit:read')"
        />
      </div>
    </div>

    <!-- 成员权限 -->
    <UiModal
      v-if="permEditing"
      :title="$t('finePerms.editorTitle', [permEditing.name])"
      :subtitle="permEditing.email"
      :width="480"
      @close="permEditing = null"
    >
      <MemberPermissionsEditor
        :member="permEditing"
        :saving="permSaving"
        @save="savePermissions"
        @cancel="permEditing = null"
      />
    </UiModal>

    <!-- 新邀请 -->
    <UiModal
      v-if="showInvite"
      :title="$t('settingsTeam.kfj4abr')"
      :subtitle="$t('settingsTeam.k1m7esfu')"
      :width="460"
      @close="showInvite = false"
    >
      <form id="invite-form" class="stack" @submit.prevent="submitInvite">
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.ktqaice') }}</span>
          <select v-model="inviteForm.role" class="select" name="role">
            <option value="member">{{ $t('settingsTeam.k1ft2unn') }}</option>
            <option value="viewer">{{ $t('settingsTeam.k1yyopd1') }}</option>
            <option value="admin">{{ $t('settingsTeam.k1ughn51') }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.kw2kz7f') }}</span>
          <input
            v-model="inviteForm.email"
            class="input"
            type="email"
            name="email"
            :placeholder="$t('settingsTeam.kuvf0kn')"
          />
        </label>
        <label v-if="teams.length" class="field">
          <span class="field-label">{{ $t('settingsTeam.k3vcj63') }}</span>
          <select v-model="inviteForm.teamId" class="select">
            <option value="">{{ $t('settingsTeam.k1tjyr6') }}</option>
            <option v-for="it in teams" :key="it.id" :value="it.id">{{ it.name }}</option>
          </select>
        </label>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ $t('settingsTeam.k9h1akg') }}</span>
            <select v-model.number="inviteForm.expiresInHours" class="select">
              <option :value="24">{{ $t('settingsTeam.k4zchx2') }}</option>
              <option :value="72">{{ $t('settingsTeam.ktacakx') }}</option>
              <option :value="168">{{ $t('settingsTeam.k1rcyjuv') }}</option>
              <option :value="720">{{ $t('settingsTeam.k152emef') }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('settingsTeam.kp17fck') }}</span>
            <input v-model.number="inviteForm.maxUses" class="input" type="number" min="1" max="100" />
          </label>
        </div>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showInvite = false">{{ $t('settingsTeam.kldkknc') }}</button>
        <button type="submit" form="invite-form" class="kbtn primary">{{ $t('settingsTeam.k10l49z7') }}</button>
      </template>
    </UiModal>
    <UiModal
      v-if="created"
      :title="$t('settingsTeam.k20ksw6')"
      :subtitle="$t('settingsTeam.kxuroao')"
      :width="520"
      @close="created = null"
    >
      <div class="stack">
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.k12g187o') }}</span>
          <div class="hstack nowrap">
            <input
              class="input code"
              readonly
              :value="created.url"
              data-testid="invite-url"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button type="button" class="kbtn" @click="copy(created.url)">{{ $t('settingsTeam.klvqx34') }}</button>
          </div>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.kee0fl2') }}</span>
          <div class="hstack nowrap">
            <input
              class="input code"
              readonly
              :value="created.code"
              data-testid="invite-code"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button type="button" class="kbtn" @click="copy(created.code)">{{ $t('settingsTeam.klvqx34') }}</button>
          </div>
        </label>
        <p class="field-hint">
          {{
            $t('settingsTeam.k1a9pewy', [
              ROLE_LABEL[created.invite.role],
              formatDate(created.invite.expiresAt),
              created.invite.maxUses,
            ])
          }}
        </p>
      </div>
      <template #footer>
        <button type="button" class="kbtn primary" @click="created = null">{{ $t('settingsTeam.ke6ugyy') }}</button>
      </template>
    </UiModal>

    <!-- 重置密码 -->
    <UiModal
      v-if="resetting"
      :title="$t('settingsTeam.keqys2h', [resetting.name])"
      :subtitle="$t('settingsTeam.k1jvd0w0')"
      :width="420"
      @close="resetting = null"
    >
      <form id="reset-form" class="stack" @submit.prevent="submitReset">
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.k1mbde68') }}</span>
          <div class="hstack nowrap">
            <input v-model="resetPwd" class="input code" type="text" autocomplete="off" autofocus />
            <button type="button" class="kbtn" @click="genPassword">{{ $t('settingsTeam.k3ix55a') }}</button>
          </div>
          <span class="field-hint">{{ $t('teamLifecycle.resetHint') }}</span>
        </label>
        <p v-if="resetError" class="field-error" role="alert">{{ resetError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="resetting = null">{{ $t('settingsTeam.kldkknc') }}</button>
        <button type="submit" form="reset-form" class="kbtn primary danger">{{ $t('settingsTeam.kz15q9y') }}</button>
      </template>
    </UiModal>

    <!-- 离职交接 -->
    <UiModal
      v-if="handover"
      :title="$t('teamLifecycle.handoverTitle', [handover.name])"
      :subtitle="$t('teamLifecycle.handoverSub')"
      :width="500"
      @close="handover = null"
    >
      <div class="stack" data-testid="handover-dialog">
        <StateBlock v-if="handoverLoading" state="loading" compact />
        <ul v-else-if="handoverCounts" class="handover-counts" data-testid="handover-counts">
          <li v-for="k in HANDOVER_TYPES" :key="k" :data-type="k">
            <span class="dim">{{ $t(`teamLifecycle.type_${k}`) }}</span
            ><b>{{ handoverCounts[k] }}</b>
          </li>
        </ul>
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.kte4lo7') }}</span>
          <select v-model="handoverTo" class="select" data-testid="handover-receiver">
            <option value="" disabled>{{ $t('settingsTeam.k16f96yk') }}</option>
            <option v-for="m in handoverReceivers" :key="m.id" :value="m.id">
              {{ $t('fmt.paren', [m.name, ROLE_LABEL[m.role]]) }}
            </option>
          </select>
        </label>
        <template v-if="handoverCounts">
          <fieldset v-if="handoverCounts.emailAccounts > 0" class="field handover-email">
            <legend class="field-label">{{ $t('teamLifecycle.emailLegend') }}</legend>
            <label v-for="mode in ['transfer', 'disable', 'keep'] as const" :key="mode" class="hstack">
              <input v-model="handoverOpts.emailAccounts" type="radio" name="handover-email" :value="mode" />
              <span>{{ $t(`teamLifecycle.emailMode_${mode}`) }}</span>
            </label>
          </fieldset>
          <label v-if="handoverCounts.workflows > 0" class="hstack">
            <input v-model="handoverWorkflows" type="checkbox" data-testid="handover-workflows" />
            <span>{{ $t('teamLifecycle.moveWorkflows', [handoverCounts.workflows]) }}</span>
          </label>
          <label v-if="handoverCounts.schedules > 0" class="hstack">
            <input v-model="handoverSchedules" type="checkbox" data-testid="handover-schedules" />
            <span>{{ $t('teamLifecycle.moveSchedules', [handoverCounts.schedules]) }}</span>
          </label>
          <p v-if="handoverOpts.schedules && handoverCounts.schedules > 0" class="field-hint">
            {{ $t('teamLifecycle.schedulesHint') }}
          </p>
        </template>
      </div>
      <template #footer>
        <button type="button" class="kbtn" @click="handover = null">{{ $t('settingsTeam.kldkknc') }}</button>
        <button
          type="button"
          class="kbtn primary"
          data-testid="handover-submit"
          :disabled="!handoverTo || handoverBusy"
          @click="submitHandover"
        >
          {{ $t('settingsTeam.k16n1m4x') }}
        </button>
      </template>
    </UiModal>

    <!-- 直接添加成员 -->
    <UiModal
      v-if="showCreate"
      :title="$t('teamLifecycle.createTitle')"
      :subtitle="$t('teamLifecycle.createSub')"
      :width="460"
      @close="showCreate = false"
    >
      <form id="create-member-form" class="stack" data-testid="create-member-form" @submit.prevent="submitCreate">
        <label class="field">
          <span class="field-label">{{ $t('teamLifecycle.email') }}</span>
          <input v-model="createForm.email" class="input" type="email" name="email" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('teamLifecycle.name') }}</span>
          <input v-model="createForm.name" class="input" name="name" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('settingsTeam.ktqaice') }}</span>
          <select v-model="createForm.role" class="select" name="role">
            <option value="member">{{ $t('settingsTeam.k1ft2unn') }}</option>
            <option value="viewer">{{ $t('settingsTeam.k1yyopd1') }}</option>
            <option v-if="currentRole === 'owner'" value="admin">{{ $t('settingsTeam.k1ughn51') }}</option>
          </select>
        </label>
        <label v-if="teams.length" class="field">
          <span class="field-label">{{ $t('settingsTeam.k3vcj63') }}</span>
          <select v-model="createForm.teamId" class="select">
            <option value="">{{ $t('settingsTeam.k1tjyr6') }}</option>
            <option v-for="it in teams" :key="it.id" :value="it.id">{{ it.name }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('teamLifecycle.initialPassword') }}</span>
          <div class="hstack nowrap">
            <input v-model="createForm.password" class="input code" type="text" name="password" autocomplete="off" />
            <button type="button" class="kbtn" @click="genCreatePassword">{{ $t('settingsTeam.k3ix55a') }}</button>
          </div>
          <span class="field-hint">{{ $t('teamLifecycle.initialHint') }}</span>
        </label>
        <p v-if="createError" class="field-error" role="alert">{{ createError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showCreate = false">{{ $t('settingsTeam.kldkknc') }}</button>
        <button type="submit" form="create-member-form" class="kbtn primary" :disabled="createBusy">
          {{ $t('teamLifecycle.createSubmit') }}
        </button>
      </template>
    </UiModal>

    <!-- 团队 -->
    <UiModal
      v-if="showTeam"
      :title="teamForm.id ? $t('settingsTeam.k1gd909s') : $t('settingsTeam.k14ohq40')"
      :width="460"
      @close="showTeam = false"
    >
      <form id="team-form" class="stack" @submit.prevent="submitTeam">
        <label class="field"
          ><span class="field-label">{{ $t('settingsTeam.k1dhu8mw') }}</span
          ><input v-model="teamForm.name" class="input" autofocus
        /></label>
        <fieldset class="members-pick">
          <legend class="field-label">{{ $t('settingsTeam.k1ht4tfl') }}</legend>
          <label v-for="m in members.filter((x) => !x.disabled)" :key="m.id" class="check">
            <input v-model="teamForm.memberIds" type="checkbox" :value="m.id" />{{ m.name }}
            <span class="muted">{{ ROLE_LABEL[m.role] }}</span>
          </label>
        </fieldset>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showTeam = false">{{ $t('settingsTeam.kldkknc') }}</button>
        <button type="submit" form="team-form" class="kbtn primary">{{ $t('settingsTeam.k1xlvxln') }}</button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.handover-counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.handover-counts li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
}
.handover-counts b {
  font-size: 16px;
}
.handover-email {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.perm-count {
  display: inline-block;
  margin-left: 4px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  background: var(--accent-soft, rgba(37, 99, 235, 0.12));
}
.tabs {
  margin-bottom: 16px;
}
.who {
  display: flex;
  align-items: center;
  gap: 6px;
}
.small {
  font-size: 12px;
}
.role {
  width: 120px;
  height: 30px;
}
.row-actions {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.perm-hint {
  margin-top: 10px;
}
.audit-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.audit-filters .select {
  width: 160px;
}
.audit-filters .date .input {
  width: 150px;
}
.nowrap {
  white-space: nowrap;
}
.hstack.nowrap {
  flex-wrap: nowrap;
}
.hstack.nowrap .input {
  flex: 1;
}
.summary {
  min-width: 220px;
  overflow-wrap: anywhere;
}
.members-pick {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
