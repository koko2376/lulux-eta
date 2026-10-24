<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as sk from '../api/skills'
import AgentAvatar from '../components/AgentAvatar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import PermNote from '../components/ui/PermNote.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import { can } from '../lib/session'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/** 按 Agent 选择可用的技能（GET/PUT /api/agents/:id/skills） */
const store = useAppStore()
const route = useRoute()
const router = useRouter()

const skills = ref<sk.Skill[]>([])
const categories = ref<sk.SkillCategory[]>([])
const config = ref<sk.AgentSkillConfig | null>(null)
const mode = ref<sk.AgentSkillMode>('all')
const picked = ref<string[]>([])
const query = ref('')
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)

const agentId = computed(() => {
  const id = typeof route.query.agent === 'string' ? route.query.agent : ''
  return store.agents.some((a) => a.id === id) ? id : (store.agents[0]?.id ?? '')
})
const agent = computed(() => store.agents.find((a) => a.id === agentId.value) ?? null)
const editable = computed(() => can('settings:write'))

async function loadSkills(): Promise<void> {
  const res = await sk.listSkills()
  skills.value = res.skills
  categories.value = res.categories
}

async function loadConfig(): Promise<void> {
  if (!agentId.value) return
  config.value = null
  const next = await sk.getAgentSkills(agentId.value)
  if (next.agentId !== agentId.value) return
  config.value = next
  mode.value = next.mode
  picked.value = next.mode === 'selected' ? [...next.skills] : skills.value.filter((s) => s.enabled).map((s) => s.name)
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    if (!store.agents.length) await store.refreshAgents()
    await loadSkills()
    await loadConfig()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(agentId, () => {
  if (!loading.value) loadConfig().catch((error) => (loadError.value = errorText(error)))
})

function selectAgent(id: string): void {
  void router.replace({ query: { ...route.query, agent: id } })
}

const groups = computed(() => {
  const label = Object.fromEntries(categories.value.map((c) => [c.id, c.label]))
  const list = sk.searchSkills(skills.value, query.value)
  const map = new Map<string, sk.Skill[]>()
  for (const s of list) {
    const key = s.category ?? 'other'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return [...map].map(([id, items]) => ({ id, label: label[id] ?? id, items }))
})

const dirty = computed(() => {
  const c = config.value
  if (!c) return false
  if (c.mode !== mode.value) return true
  if (mode.value !== 'selected') return false
  const a = [...c.skills].sort().join(',')
  const b = [...picked.value].sort().join(',')
  return a !== b
})

function togglePick(name: string): void {
  picked.value = picked.value.includes(name) ? picked.value.filter((n) => n !== name) : [...picked.value, name]
}

function pickGroup(items: sk.Skill[], on: boolean): void {
  const names = items.map((s) => s.name)
  picked.value = on ? [...new Set([...picked.value, ...names])] : picked.value.filter((n) => !names.includes(n))
}

async function save(): Promise<void> {
  if (!agentId.value) return
  saving.value = true
  try {
    config.value = await sk.putAgentSkills(agentId.value, mode.value, mode.value === 'selected' ? picked.value : [])
    toast.success(t('agentSkills.kqryxe4', [agent.value?.name ?? '']))
  } finally {
    saving.value = false
  }
}

const MODE_TEXT: Record<sk.AgentSkillMode, string> = {
  all: t('agentSkills.k19payd4'),
  selected: t('agentSkills.k16dth5'),
  none: t('agentSkills.k1mp609x'),
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('agentSkills.k9nubrc')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('agentSkills.kb991it') }}</h2>
        <RouterLink class="link" to="/skills">{{ $t('agentSkills.k1hir9x1') }}</RouterLink>
      </div>
      <nav class="side-body">
        <button
          v-for="a in store.agents"
          :key="a.id"
          type="button"
          class="nav-row agent-row"
          :class="{ on: a.id === agentId }"
          :aria-pressed="a.id === agentId"
          @click="selectAgent(a.id)"
        >
          <AgentAvatar :agent-id="a.id" :size="24" />
          <span class="agent-row-name" :title="a.description">{{ a.name }}</span>
          <span v-if="a.kind === 'kernel'" class="count">{{ $t('agentSkills.k13pd4cx') }}</span>
        </button>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar
      :title="agent ? $t('agentSkills.k1fx61fv', [agent.name]) : $t('agentSkills.k1lx6vnd')"
      :sub="config ? $t('agentSkills.k7xq8v7', [config.available.length]) : ''"
    >
      <button
        v-perm="'settings:write'"
        type="button"
        class="kbtn primary"
        :disabled="!dirty || saving"
        data-testid="agent-skills-save"
        @click="save"
      >
        {{ saving ? $t('agentSkills.k17glvo8') : $t('agentSkills.k1xlvxln') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="settings:write" :text="$t('agentSkills.k1d7pbdu')" />
        <StateBlock v-if="loading" state="loading" />
        <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
        <StateBlock v-else-if="!agent" state="empty" :title="$t('agentSkills.k1pggnjb')" />
        <template v-else>
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('agentSkills.k17bxbgd') }}</h2>
                <div class="panel-sub">{{ MODE_TEXT[mode] }}</div>
              </div>
              <div class="segmented" role="radiogroup" :aria-label="$t('agentSkills.k17bxbgd')">
                <button
                  v-for="m in ['all', 'selected', 'none'] as const"
                  :key="m"
                  type="button"
                  role="radio"
                  :aria-checked="mode === m"
                  :class="{ on: mode === m }"
                  :disabled="!editable"
                  @click="mode = m"
                >
                  {{
                    m === 'all'
                      ? $t('agentSkills.kx69ng9')
                      : m === 'selected'
                        ? $t('agentSkills.kf9ovgu')
                        : $t('agentSkills.k1idf8vg')
                  }}
                </button>
              </div>
            </div>
          </section>

          <section v-if="mode === 'selected'" class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('agentSkills.k1co9rq5') }}</h2>
                <div class="panel-sub">{{ $t('agentSkills.k8hg17u', [picked.length]) }}</div>
              </div>
              <label class="search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="m15.5 15.5 4.5 4.5" />
                </svg>
                <span class="sr-only">{{ $t('agentSkills.k62hofd') }}</span>
                <input v-model="query" :placeholder="$t('agentSkills.k1pq0o1h')" spellcheck="false" />
              </label>
            </div>
            <div v-for="g in groups" :key="g.id" class="pick-group">
              <div class="pick-head">
                <h3>{{ g.label }}</h3>
                <button type="button" class="link" :disabled="!editable" @click="pickGroup(g.items, true)">
                  {{ $t('agentSkills.kh9zbmx') }}
                </button>
                <button type="button" class="link" :disabled="!editable" @click="pickGroup(g.items, false)">
                  {{ $t('agentSkills.k10wdk3x') }}
                </button>
              </div>
              <label v-for="s in g.items" :key="s.name" class="pick-row" :class="{ off: !s.enabled }">
                <input
                  type="checkbox"
                  :checked="picked.includes(s.name)"
                  :disabled="!editable"
                  :aria-label="s.name"
                  @change="togglePick(s.name)"
                />
                <span class="pick-text">
                  <strong>{{ s.name }}</strong>
                  <span v-if="!s.enabled" class="badge-off">{{ $t('agentSkills.ku3ouk7') }}</span>
                  <span class="pick-desc" :title="s.description">{{ s.description }}</span>
                </span>
              </label>
            </div>
          </section>

          <section v-else-if="mode === 'all' && config" class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('agentSkills.kjrwa14') }}</h2>
                <div class="panel-sub">{{ config.available.join($t('fmt.listSep')) || $t('agentSkills.khf0hw4') }}</div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.agent-row {
  gap: 10px;
}
.agent-row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-group {
  padding: 4px 18px 12px;
}
.pick-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0 4px;
}
.pick-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  margin-right: auto;
}
.pick-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
  cursor: pointer;
}
.pick-row input {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  flex: none;
}
.pick-text {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  font-size: 13px;
}
.pick-text strong {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 600;
}
.pick-desc {
  flex-basis: 100%;
  color: var(--text-secondary);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-row.off strong {
  color: var(--text-secondary);
}
</style>
