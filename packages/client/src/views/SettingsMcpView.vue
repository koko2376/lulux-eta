<script setup lang="ts">
import { PERMISSION_LEVELS, type PermissionLevel } from '../lib/permissions'
import FieldError from '../components/ui/FieldError.vue'
import { useFieldErrors } from '../composables/useFieldErrors'
import ServerFeatureNote from '../components/ui/ServerFeatureNote.vue'
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { envToText, parseArgsText, parseEnvText, parseHeadersText } from '../lib/kv'
import { isDesktop } from '../lib/window'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const store = useAppStore()
const loading = ref(true)
const loadError = ref('')
const busy = reactive<Record<string, boolean>>({})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await Promise.all([store.refreshMcpServers(), store.refreshSettings()])
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const STATUS: Record<string, string> = {
  connected: t('settingsMcp.ksas2is'),
  connecting: t('settingsMcp.ktauwie'),
  stopped: t('settingsMcp.kwpc5ea'),
  error: t('settingsMcp.k1nhgkqe'),
}

async function toggle(server: api.McpServer, enabled: boolean): Promise<void> {
  busy[server.id] = true
  try {
    await store.toggleMcpServer(server.id, enabled)
  } finally {
    busy[server.id] = false
  }
}

async function refresh(server: api.McpServer): Promise<void> {
  busy[server.id] = true
  try {
    await store.reconnectMcpServer(server.id)
    toast.success(t('settingsMcp.k1lw1ana', [server.name]))
  } finally {
    busy[server.id] = false
  }
}

async function remove(server: api.McpServer): Promise<void> {
  const ok = await confirmDialog({
    title: t('settingsMcp.k8t1ghu', [server.name]),
    message: t('settingsMcp.k2ffpu5'),
    confirmText: t('settingsMcp.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  await api.deleteMcpServer(server.id)
  await store.refreshMcpServers()
  toast.success(t('settingsMcp.k1xqwrmq'))
}

/** 新会话默认权限（契约 §6.11；取代旧的“工具调用审批 每次询问 / 自动批准”） */
async function setDefaultLevel(level: PermissionLevel): Promise<void> {
  if (level === store.defaultPermissionLevel) return
  if (level === 'full') {
    const ok = await confirmDialog({
      title: t('permission.fullConfirmTitle'),
      message: t('permission.fullConfirmMessage'),
      confirmText: t('permission.fullConfirmOk'),
      danger: true,
    })
    if (!ok) return
  }
  await store.saveSettings({ defaultPermissionLevel: level })
  toast.success(t('permission.saved', [t(`permission.${level}`)]))
}

/* ── 表单 ── */
const showForm = ref(false)
const editing = ref<api.McpServer | null>(null)
const saving = ref(false)
const formError = ref('')
const fe = useFieldErrors<'name' | 'url' | 'command'>('mcp-form')
const form = reactive({
  transport: 'stdio' as 'stdio' | 'http',
  name: '',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  enabled: true,
})

function transportOf(server: api.McpServer): 'stdio' | 'http' {
  return server.transport === 'http' ? 'http' : 'stdio'
}

function openCreate(): void {
  editing.value = null
  Object.assign(form, {
    transport: 'stdio',
    name: '',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    enabled: true,
  })
  formError.value = ''
  showForm.value = true
}
function openEdit(server: api.McpServer): void {
  editing.value = server
  Object.assign(form, {
    transport: transportOf(server),
    name: server.name,
    command: server.command,
    argsText: (server.args ?? []).join('\n'),
    envText: envToText(server.env ?? {}),
    url: server.url ?? '',
    headersText: '',
    enabled: server.enabled,
  })
  formError.value = ''
  showForm.value = true
}

async function save(): Promise<void> {
  formError.value = ''
  fe.clear()
  let input: api.McpServerInput
  if (form.transport === 'http') {
    if (!fe.require({ name: form.name, url: form.url }, () => t('ui.required'))) return
    if (!/^https?:\/\//i.test(form.url.trim())) return void fe.set('url', t('settingsMcp.kmrev5m'))
    const { headers, errors } = parseHeadersText(form.headersText)
    if (errors.length) return void (formError.value = errors.join(t('fmt.clauseSep')))
    input = { name: form.name.trim(), url: form.url.trim(), enabled: form.enabled }
    // 编辑时留空表示保留原有请求头（接口不返回值，只返回键名）
    if (!editing.value || form.headersText.trim()) input.headers = headers
  } else {
    if (!fe.require({ name: form.name, command: form.command }, () => t('ui.required'))) return
    const { env, errors } = parseEnvText(form.envText)
    if (errors.length) return void (formError.value = errors.join(t('fmt.clauseSep')))
    input = {
      name: form.name.trim(),
      command: form.command.trim(),
      args: parseArgsText(form.argsText),
      env,
      enabled: form.enabled,
    }
  }
  saving.value = true
  try {
    if (editing.value) await api.updateMcpServer(editing.value.id, input)
    else await api.createMcpServer(input)
    showForm.value = false
    await store.refreshMcpServers()
    toast.success(t('settingsMcp.k1l5gy27'))
  } catch (error) {
    formError.value =
      error instanceof api.ApiError && error.code === 'MCP_COMMAND_REJECTED'
        ? t('settingsMcp.kpgbwji', [error.message])
        : errorText(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsMcp.k7cjeqp')" :sub="$t('settingsMcp.k1k7i4ij')">
      <button v-perm="'security:manage'" type="button" class="kbtn primary" @click="openCreate">
        {{ $t('settingsMcp.kdfapxc') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <ServerFeatureNote feature="mcp" />
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('permission.settingsTitle') }}</h2>
              <div class="panel-sub">{{ $t('permission.settingsSub') }}</div>
            </div>
            <div
              class="segmented"
              role="radiogroup"
              :aria-label="$t('permission.settingsAria')"
              data-testid="default-permission-level"
            >
              <button
                v-for="level in PERMISSION_LEVELS"
                :key="level"
                type="button"
                role="radio"
                :data-level="level"
                :aria-checked="store.defaultPermissionLevel === level"
                :class="{ on: store.defaultPermissionLevel === level }"
                @click="setDefaultLevel(level)"
              >
                {{ $t(`permission.${level}`) }}
              </button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsMcp.kjhoedj') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsMcp.k1hd1ijv') }}
              </div>
            </div>
          </div>
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!store.mcpServers.length"
            state="empty"
            :title="$t('settingsMcp.k13zr0dn')"
            :message="$t('settingsMcp.k1engpon')"
            compact
          >
            <button v-perm="'security:manage'" type="button" class="kbtn primary" @click="openCreate">
              {{ $t('settingsMcp.kdfapxc') }}
            </button>
          </StateBlock>
          <div v-else>
            <div v-for="server in store.mcpServers" :key="server.id" class="row-item mrow">
              <div class="grow">
                <div class="t">
                  {{ server.name }}
                  <span
                    v-if="server.state"
                    :class="
                      server.state.status === 'connected'
                        ? 'badge-on'
                        : server.state.status === 'error'
                          ? 'badge-bad'
                          : 'badge-off'
                    "
                  >
                    {{ STATUS[server.state.status] ?? server.state.status }}
                  </span>
                  <span v-if="server.approved === false" class="badge-bad">{{ $t('settingsMcp.k1eo14mb') }}</span>
                  <span class="badge-off">{{
                    transportOf(server) === 'http' ? $t('settingsMcp.k1lpyzf4') : $t('settingsMcp.k1b9eybd')
                  }}</span>
                  <span v-if="server.createdBy === 'agent'" class="badge-off" :title="$t('settingsMcp.k1u05o2t')">{{
                    $t('settingsMcp.k1f5m2fe')
                  }}</span>
                </div>
                <div v-if="transportOf(server) === 'http'" class="d code" :title="server.url">
                  {{ server.url
                  }}<template v-if="server.headerKeys?.length">
                    {{ $t('settingsMcp.k1kdhkm6', [server.headerKeys.join($t('fmt.listSep'))]) }}</template
                  >
                </div>
                <div v-else class="d code">{{ server.command }} {{ (server.args ?? []).join(' ') }}</div>
                <div v-if="server.state?.error" class="d err">{{ server.state.error }}</div>
                <div v-if="server.state?.tools?.length" class="d">
                  {{ $t('settingsMcp.k1ylu3f4', [server.state.tools.join($t('fmt.listSep'))]) }}
                </div>
              </div>
              <UiSwitch
                :model-value="server.enabled"
                :label="$t('settingsMcp.k15osxgw', [server.name])"
                :disabled="busy[server.id]"
                @update:model-value="toggle(server, $event)"
              />
              <div class="panel-actions">
                <button
                  type="button"
                  class="kbtn sm"
                  :disabled="busy[server.id] || !server.enabled"
                  :title="server.approved === false ? $t('settingsMcp.k1x31c1l') : undefined"
                  @click="refresh(server)"
                >
                  {{ server.approved === false ? $t('settingsMcp.k1tef9q2') : $t('settingsMcp.kfk0ip6') }}
                </button>
                <button v-perm="'security:manage'" type="button" class="kbtn sm" @click="openEdit(server)">
                  {{ $t('settingsMcp.k1alsnuo') }}
                </button>
                <button v-perm="'security:manage'" type="button" class="kbtn sm danger" @click="remove(server)">
                  {{ $t('settingsMcp.kfcqesv') }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <UiModal
      v-if="showForm"
      :title="editing ? $t('settingsMcp.kx9psfj', [editing.name]) : $t('settingsMcp.kdfapxc')"
      :width="580"
      @close="showForm = false"
    >
      <div v-if="!editing" class="segmented transport-tabs" role="radiogroup" :aria-label="$t('settingsMcp.k1rwx0k3')">
        <button
          type="button"
          role="radio"
          :aria-checked="form.transport === 'stdio'"
          :class="{ on: form.transport === 'stdio' }"
          @click="form.transport = 'stdio'"
        >
          {{ $t('settingsMcp.k1b9eybd') }}
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="form.transport === 'http'"
          :class="{ on: form.transport === 'http' }"
          @click="form.transport = 'http'"
        >
          {{ $t('settingsMcp.k1lpyzf4') }}
        </button>
      </div>
      <div v-if="form.transport === 'http'" class="note confirm-note">
        {{ $t('settingsMcp.ktvau5n') }}
      </div>
      <div v-else class="note warn confirm-note">
        {{ isDesktop ? $t('settingsMcp.kpedel6') : $t('settingsMcp.k7ykrwo') }}
      </div>
      <form id="mcp-form" class="form-grid" novalidate @submit.prevent="save">
        <label class="field">
          <span class="field-label">{{ $t('settingsMcp.k7qqgy7') }}</span>
          <input
            v-model="form.name"
            class="input"
            :class="{ invalid: fe.errors.name }"
            data-field="name"
            required
            maxlength="60"
            @input="fe.clear('name')"
          />
          <FieldError :msg="fe.errors.name" />
        </label>
        <template v-if="form.transport === 'http'">
          <label class="field">
            <span class="field-label">URL</span>
            <input
              v-model="form.url"
              class="input code"
              name="url"
              placeholder="https://mcp.example.com/mcp"
              spellcheck="false"
              required
              :class="{ invalid: fe.errors.url }"
              data-field="url"
              @input="fe.clear('url')"
            />
            <FieldError :msg="fe.errors.url" />
          </label>
          <label class="field span-all">
            <span class="field-label">
              {{ $t('settingsMcp.kdveu4y')
              }}<template v-if="editing?.headerKeys?.length">
                {{ $t('settingsMcp.krz3dcc', [editing.headerKeys.join($t('fmt.listSep'))]) }}</template
              >
            </span>
            <textarea
              v-model="form.headersText"
              class="textarea code"
              name="headers"
              rows="3"
              spellcheck="false"
              placeholder="Authorization: Bearer …"
            ></textarea>
          </label>
        </template>
        <label v-if="form.transport === 'stdio'" class="field">
          <span class="field-label">{{ $t('settingsMcp.k1d4t8np') }}</span>
          <input
            v-model="form.command"
            class="input code"
            :class="{ invalid: fe.errors.command }"
            data-field="command"
            placeholder="npx"
            spellcheck="false"
            required
            @input="fe.clear('command')"
          />
          <FieldError :msg="fe.errors.command" />
        </label>
        <label v-if="form.transport === 'stdio'" class="field span-all">
          <span class="field-label">{{ $t('settingsMcp.k1wka8tr') }}</span>
          <textarea
            v-model="form.argsText"
            class="textarea code"
            rows="3"
            spellcheck="false"
            placeholder="-y&#10;@scope/some-mcp-server"
          ></textarea>
        </label>
        <label v-if="form.transport === 'stdio'" class="field span-all">
          <span class="field-label">{{ $t('settingsMcp.k14xgxse') }}</span>
          <textarea v-model="form.envText" class="textarea code" rows="3" spellcheck="false"></textarea>
        </label>
        <label class="check span-all"
          ><input v-model="form.enabled" type="checkbox" /> {{ $t('settingsMcp.k16r1gw3') }}</label
        >
        <p v-if="formError" class="field-error span-all" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('settingsMcp.kldkknc') }}</button>
        <button type="submit" form="mcp-form" class="kbtn primary" :disabled="saving">
          {{
            saving
              ? form.transport === 'http'
                ? $t('settingsMcp.kv53i71')
                : $t('settingsMcp.kdpl2ne')
              : $t('settingsMcp.k1xlvxln')
          }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.mrow {
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
}
.confirm-note {
  margin-bottom: 14px;
}
.transport-tabs {
  margin-bottom: 14px;
}
</style>
