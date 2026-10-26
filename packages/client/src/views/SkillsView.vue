<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import FilePick from '../components/ui/FilePick.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '../api'
import * as sk from '../api/skills'
import DocMarkdown from '../components/DocMarkdown.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import PermNote from '../components/ui/PermNote.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { downloadBlob, formatBytes } from '../lib/download'
import { isServerMode } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { intlLocale, labelled, t } from '../i18n'

const route = useRoute()
const router = useRouter()

const skills = ref<sk.Skill[]>([])
const categories = ref<sk.SkillCategory[]>([])
const loading = ref(true)
const loadError = ref('')
const query = ref('')
const filter = ref(typeof route.query.filter === 'string' ? route.query.filter : '')
const busy = reactive<Record<string, boolean>>({})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await sk.listSkills()
    skills.value = res.skills
    categories.value = res.categories
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(filter, (value) => {
  void router.replace({ query: { ...route.query, filter: value || undefined } })
})

const categoryLabel = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c.label])))
const shown = computed(() =>
  sk.searchSkills(skills.value, query.value).filter((s) => sk.matchesFilter(s, filter.value)),
)
const counts = computed(() => ({
  imported: skills.value.filter((s) => s.source !== 'builtin').length,
  disabled: skills.value.filter((s) => !s.enabled).length,
  update: skills.value.filter((s) => s.updateAvailable).length,
}))
const heading = computed(() => {
  if (filter.value === 'imported') return t('skills.k1oexni2')
  if (filter.value === 'disabled') return t('skills.ku3ouk7')
  if (filter.value === 'update') return t('skills.k1lwa1fx')
  return filter.value ? (categoryLabel.value[filter.value] ?? filter.value) : t('skills.k193dpst')
})

function replaceSkill(next: sk.Skill): void {
  const i = skills.value.findIndex((s) => s.name === next.name)
  if (i >= 0) skills.value[i] = next
  else skills.value.push(next)
  if (detail.value?.name === next.name) detail.value = { ...detail.value, ...next }
}

async function toggle(skill: sk.Skill, enabled: boolean): Promise<void> {
  busy[skill.name] = true
  try {
    replaceSkill(await sk.setSkillEnabled(skill.name, enabled))
    toast.success(t('skills.k1iy6mhf', [skill.name, enabled ? t('skills.k1n2qbel') : t('skills.k1ocxl5d')]))
  } finally {
    busy[skill.name] = false
  }
}

async function remove(skill: sk.Skill): Promise<void> {
  const ok = await confirmDialog({
    title: t('skills.kzzgbp', [skill.name]),
    message: t('skills.k1fnp1wc'),
    confirmText: t('skills.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  busy[skill.name] = true
  try {
    await sk.deleteSkill(skill.name)
    skills.value = skills.value.filter((s) => s.name !== skill.name)
    if (detail.value?.name === skill.name) detail.value = null
    toast.success(t('skills.k1xqwrmq'))
  } finally {
    busy[skill.name] = false
  }
}

async function reset(skill: sk.Skill): Promise<void> {
  const ok = await confirmDialog({
    title: t('skills.k1m3l0ut', [skill.name]),
    message: skill.updateAvailable ? t('skills.k1g3nuys') : t('skills.km3qhru'),
    confirmText: t('skills.k18tv42j'),
    danger: true,
  })
  if (!ok) return
  busy[skill.name] = true
  try {
    replaceSkill(await sk.resetSkill(skill.name))
    if (detail.value?.name === skill.name) await openDetail(skill)
    toast.success(t('skills.kl88xp5'))
  } finally {
    busy[skill.name] = false
  }
}

async function exportZip(skill: sk.Skill): Promise<void> {
  busy[skill.name] = true
  try {
    downloadBlob(await sk.exportSkill(skill.name), `${skill.name}.zip`)
  } finally {
    busy[skill.name] = false
  }
}

/* ── 详情 ── */
const detail = ref<sk.SkillDetail | null>(null)
const detailLoading = ref(false)
const detailTab = ref<'doc' | 'files' | 'meta'>('doc')
const fileView = ref<sk.SkillFile | null>(null)

async function openDetail(skill: sk.Skill): Promise<void> {
  detailLoading.value = true
  detailTab.value = 'doc'
  fileView.value = null
  try {
    detail.value = await sk.getSkill(skill.name)
  } finally {
    detailLoading.value = false
  }
}

async function openFile(path: string): Promise<void> {
  if (!detail.value) return
  fileView.value = await sk.getSkillFile(detail.value.name, path)
}

function requiresText(r: sk.SkillRequires | undefined): string[] {
  if (!r) return []
  const out: string[] = []
  if (r.tools.length) out.push(t('skills.k1ylu3f4', [r.tools.join(t('fmt.listSep'))]))
  if (r.mcp.length) out.push(labelled('MCP', r.mcp.join(t('fmt.listSep'))))
  if (r.npm.length) out.push(t('skills.ke5prti', [r.npm.join(t('fmt.listSep'))]))
  if (r.python) out.push(t('skills.knpxazu'))
  return out
}

function when(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(intlLocale(), { hour12: false })
}

/* ── 安装 ── */
type InstallKind = 'zip' | 'url' | 'folder'
const showInstall = ref(false)
const install = reactive({
  kind: 'zip' as InstallKind,
  file: null as File | null,
  url: '',
  subpath: '',
  path: '',
  overwrite: false,
  error: '',
  conflict: false,
  saving: false,
})

function openInstall(kind: InstallKind = 'zip'): void {
  Object.assign(install, {
    kind,
    file: null,
    url: '',
    subpath: '',
    path: '',
    overwrite: false,
    error: '',
    conflict: false,
    saving: false,
  })
  showInstall.value = true
}

function pickZip(event: Event): void {
  const input = event.target as HTMLInputElement
  install.file = input.files?.[0] ?? null
  install.error = ''
  install.conflict = false
}

async function submitInstall(): Promise<void> {
  install.error = ''
  install.conflict = false
  const overwrite = install.overwrite || undefined
  const subpath = install.subpath.trim() || undefined
  let result: sk.SkillInstallResult
  install.saving = true
  try {
    if (install.kind === 'zip') {
      if (!install.file) return void (install.error = t('skills.k1uu6dtt'))
      if (install.file.size > 15 * 1024 * 1024) return void (install.error = t('skills.k1no5uje'))
      result = await sk.installSkillZip({
        filename: install.file.name,
        dataBase64: await sk.fileToBase64(install.file),
        subpath,
        overwrite,
      })
    } else if (install.kind === 'url') {
      const url = sk.normalizeInstallUrl(install.url)
      if (!/^https?:\/\//i.test(url)) return void (install.error = t('skills.k12g6mv8'))
      result = await sk.installSkillUrl({ url, subpath, overwrite })
    } else {
      if (!install.path.trim()) return void (install.error = t('skills.kutzcnp'))
      result = await sk.installSkillFolder({ path: install.path.trim(), overwrite })
    }
    replaceSkill(result.skill)
    showInstall.value = false
    toast.success(
      t('skills.ko96mt5', [result.replaced ? t('skills.k4rnyav') : t('skills.k1tcp0lz'), result.skill.name]),
    )
    if (result.skill.hasScripts) toast.info(t('skills.k1ng1qh7'))
  } catch (error) {
    install.conflict = error instanceof ApiError && error.code === 'SKILL_EXISTS'
    install.error = errorText(error)
  } finally {
    install.saving = false
  }
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('skills.kmeopdy')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('skills.kn9kmfv') }}</h2>
        <button v-perm="'settings:write'" type="button" class="link" @click="openInstall()">
          {{ $t('skills.k2ctc1m') }}
        </button>
      </div>
      <nav class="side-body">
        <button type="button" class="nav-row" :class="{ on: !filter }" :aria-pressed="!filter" @click="filter = ''">
          {{ $t('skills.k193dpst') }}<span class="count">{{ skills.length }}</span>
        </button>
        <div class="side-label">{{ $t('skills.kiouh5l') }}</div>
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          class="nav-row"
          :class="{ on: filter === c.id }"
          :aria-pressed="filter === c.id"
          @click="filter = filter === c.id ? '' : c.id"
        >
          {{ c.label }}<span class="count">{{ c.count }}</span>
        </button>
        <div class="side-label">{{ $t('skills.krfzxye') }}</div>
        <button
          type="button"
          class="nav-row"
          :class="{ on: filter === 'imported' }"
          :aria-pressed="filter === 'imported'"
          @click="filter = filter === 'imported' ? '' : 'imported'"
        >
          {{ $t('skills.k1oexni2') }}<span class="count">{{ counts.imported }}</span>
        </button>
        <button
          type="button"
          class="nav-row"
          :class="{ on: filter === 'disabled' }"
          :aria-pressed="filter === 'disabled'"
          @click="filter = filter === 'disabled' ? '' : 'disabled'"
        >
          {{ $t('skills.ku3ouk7') }}<span class="count">{{ counts.disabled }}</span>
        </button>
        <button
          v-if="counts.update"
          type="button"
          class="nav-row"
          :class="{ on: filter === 'update' }"
          :aria-pressed="filter === 'update'"
          @click="filter = filter === 'update' ? '' : 'update'"
        >
          {{ $t('skills.k1lwa1fx') }}<span class="count">{{ counts.update }}</span>
        </button>
        <div class="side-label">{{ $t('skills.k1nvzu61') }}</div>
        <RouterLink class="nav-row" to="/skills/agents">{{ $t('skills.k1980es2') }}</RouterLink>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar
      :title="$t('skills.kn9kmfv')"
      :sub="loading ? '' : $t('skills.krdayyj', [skills.length, skills.length - counts.disabled])"
    >
      <label class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('skills.k62hofd') }}</span>
        <input v-model="query" :placeholder="$t('skills.kzntr3x')" spellcheck="false" />
      </label>
      <button v-perm="'settings:write'" type="button" class="kbtn primary" @click="openInstall()">
        {{ $t('skills.kxwmlqp') }}
      </button>
    </PageTopbar>

    <div class="doc">
      <PermNote perm="settings:write" :text="$t('skills.kyzp1qw')" />
      <section class="panel skills-panel">
        <div class="panel-head">
          <div class="txt">
            <h2 class="panel-title">{{ heading }}</h2>
            <div class="panel-sub">{{ $t('skills.kkht96v') }}</div>
          </div>
        </div>
        <StateBlock v-if="loading && !skills.length" state="loading" />
        <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
        <StateBlock
          v-else-if="!shown.length"
          state="empty"
          :title="query || filter ? $t('skills.ko0ztok') : $t('skills.k15nxv6g')"
          :message="query || filter ? $t('skills.ki6fvlo') : $t('skills.k6xnu4s')"
        >
          <button v-if="query || filter" type="button" class="kbtn" @click="((query = ''), (filter = ''))">
            {{ $t('skills.kl0i1y7') }}
          </button>
          <button v-else v-perm="'settings:write'" type="button" class="kbtn primary" @click="openInstall()">
            {{ $t('skills.kxwmlqp') }}
          </button>
        </StateBlock>
        <ul v-else class="skill-list" data-testid="skill-list">
          <li v-for="s in shown" :key="s.name" class="skill-row" :class="{ off: !s.enabled }" :data-skill="s.name">
            <InitialBadge :name="s.name" :size="38" square />
            <div class="skill-main">
              <div class="skill-title">
                <button
                  type="button"
                  class="skill-name"
                  :title="$t('skills.k1r9dcej', [s.name])"
                  @click="openDetail(s)"
                >
                  {{ s.name }}
                </button>
                <span class="tag">{{ sk.SKILL_SOURCE_LABEL[s.source] }}</span>
                <span v-if="s.category" class="tag">{{ categoryLabel[s.category] ?? s.category }}</span>
                <span v-if="s.hasScripts" class="tag" :title="$t('skills.ki0tcrr')">{{ $t('skills.kzfxmnf') }}</span>
                <span v-if="s.updateAvailable" class="badge-bad" :title="$t('skills.k7eql23')">{{
                  $t('skills.k1lwa1fx')
                }}</span>
                <span v-else-if="s.modified" class="badge-off" :title="$t('skills.khvaf6r')">{{
                  $t('skills.k1jt0l61')
                }}</span>
                <span v-if="s.error" class="badge-bad" :title="s.error">{{ $t('skills.k1fai3f7') }}</span>
              </div>
              <p class="skill-desc" :title="s.description">{{ s.description }}</p>
              <div class="skill-meta">
                <span v-if="s.version">v{{ s.version }}</span>
                <span v-if="s.license">{{ $t('skills.k1o7nh80', [s.license]) }}</span>
                <span class="skill-origin" :title="sk.originLabel(s)">{{
                  $t('skills.k1lnd18n', [sk.originLabel(s)])
                }}</span>
                <span v-if="s.useCount">{{ $t('skills.kmqcn1u', [s.useCount]) }}</span>
              </div>
            </div>
            <div class="skill-actions">
              <UiSwitch
                v-perm="'settings:write'"
                :model-value="s.enabled"
                :label="$t('skills.k15osxgw', [s.name])"
                :disabled="busy[s.name]"
                @update:model-value="toggle(s, $event)"
              />
              <button type="button" class="kbtn sm" @click="openDetail(s)">{{ $t('skills.km0gmji') }}</button>
              <button type="button" class="kbtn sm" :disabled="busy[s.name]" @click="exportZip(s)">
                {{ $t('skills.k6t2455') }}
              </button>
              <button
                v-if="s.source === 'builtin' && (s.modified || s.updateAvailable)"
                v-perm="'settings:write'"
                type="button"
                class="kbtn sm"
                :disabled="busy[s.name]"
                @click="reset(s)"
              >
                {{ $t('skills.k18tv42j') }}
              </button>
              <button
                v-if="s.source !== 'builtin'"
                v-perm="'settings:write'"
                type="button"
                class="kbtn sm danger"
                :disabled="busy[s.name]"
                @click="remove(s)"
              >
                {{ $t('skills.kfcqesv') }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <!-- 详情 -->
    <UiModal
      v-if="detail || detailLoading"
      :title="detail?.name ?? $t('skills.k1jk4eca')"
      :subtitle="detail ? `${sk.SKILL_SOURCE_LABEL[detail.source]} · ${sk.originLabel(detail)}` : ''"
      :width="760"
      @close="((detail = null), (detailLoading = false))"
    >
      <StateBlock v-if="!detail" state="loading" compact />
      <template v-else>
        <div v-if="detail.updateAvailable" class="note warn detail-note">
          {{ $t('skills.k16a8w2r') }}
        </div>
        <div v-if="detail.error" class="note warn detail-note">{{ $t('skills.k1mn36ae', [detail.error]) }}</div>
        <p class="detail-desc">{{ detail.description }}</p>
        <div class="segmented detail-tabs" role="tablist" :aria-label="$t('skills.kr5uqr0')">
          <button
            type="button"
            role="tab"
            :aria-selected="detailTab === 'doc'"
            :class="{ on: detailTab === 'doc' }"
            @click="detailTab = 'doc'"
          >
            SKILL.md
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="detailTab === 'files'"
            :class="{ on: detailTab === 'files' }"
            @click="detailTab = 'files'"
          >
            {{ $t('skills.k18d7g6x', [detail.files.length]) }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="detailTab === 'meta'"
            :class="{ on: detailTab === 'meta' }"
            @click="detailTab = 'meta'"
          >
            {{ $t('skills.kpulzxe') }}
          </button>
        </div>
        <div v-if="detailTab === 'doc'" class="detail-doc" data-testid="skill-doc">
          <DocMarkdown :content="detail.body || detail.content" />
        </div>
        <div v-else-if="detailTab === 'files'" class="detail-files">
          <ul class="file-list">
            <li v-for="f in detail.files" :key="f.path">
              <button
                type="button"
                class="file-row"
                :class="{ on: fileView?.path === f.path }"
                :title="f.path"
                @click="openFile(f.path)"
              >
                <span class="file-path">{{ f.path }}</span>
                <span class="file-size">{{ formatBytes(f.size) }}</span>
              </button>
            </li>
          </ul>
          <div class="file-view">
            <p v-if="!fileView" class="dim">{{ $t('skills.krva3rt') }}</p>
            <p v-else-if="fileView.binary" class="dim">
              {{ $t('skills.k1hhuc1a', [fileView.path, formatBytes(fileView.size)]) }}
            </p>
            <pre v-else class="file-code"
              >{{ fileView.content }}{{ fileView.truncated ? $t('skills.ktvao2q') : '' }}</pre>
          </div>
        </div>
        <dl v-else class="detail-meta">
          <dt>{{ $t('skills.k1j08rmu') }}</dt>
          <dd>{{ sk.SKILL_SOURCE_LABEL[detail.source] }} · {{ sk.originLabel(detail) }}</dd>
          <template v-if="detail.upstream">
            <dt>{{ $t('skills.k1to91qs') }}</dt>
            <dd class="code">
              {{ detail.upstream.source }}{{ detail.upstream.commit ? ` @ ${detail.upstream.commit}` : '' }}
            </dd>
          </template>
          <dt>{{ $t('skills.k1k56eop') }}</dt>
          <dd>{{ detail.license || $t('skills.ku5jyc8') }}</dd>
          <dt>{{ $t('skills.k16ceynz') }}</dt>
          <dd>{{ detail.version || '—' }}</dd>
          <dt>{{ $t('skills.kta9wep') }}</dt>
          <dd>{{ detail.author || '—' }}</dd>
          <dt>{{ $t('skills.k1kmra3s') }}</dt>
          <dd>{{ detail.keywords.join($t('fmt.listSep')) || '—' }}</dd>
          <dt>{{ $t('skills.kqnxp8u') }}</dt>
          <dd>
            <template v-if="requiresText(detail.requires).length">
              <div v-for="line in requiresText(detail.requires)" :key="line">{{ line }}</div>
            </template>
            <template v-else>{{ $t('skills.kvn0761') }}</template>
          </dd>
          <dt>{{ $t('skills.k2ctc1m') }}</dt>
          <dd>
            {{
              $t('fmt.paren', [
                when(detail.installedAt),
                detail.installedBy === 'agent'
                  ? 'Agent'
                  : detail.installedBy === 'system'
                    ? $t('skills.k78xla7')
                    : $t('skills.k176s6wa'),
              ])
            }}
          </dd>
          <dt>{{ $t('skills.k3xluf0') }}</dt>
          <dd>
            {{
              $t('skills.k17aipzv', [
                detail.useCount,
                detail.lastUsedAt ? $t('skills.k17w6tis', [when(detail.lastUsedAt)]) : '',
              ])
            }}
          </dd>
        </dl>
      </template>
      <template #footer>
        <template v-if="detail">
          <button type="button" class="kbtn" @click="exportZip(detail)">{{ $t('skills.k1v9irzp') }}</button>
          <button
            v-if="detail.source === 'builtin' && (detail.modified || detail.updateAvailable)"
            v-perm="'settings:write'"
            type="button"
            class="kbtn"
            @click="reset(detail)"
          >
            {{ $t('skills.k18tv42j') }}
          </button>
          <button
            v-if="detail.source !== 'builtin'"
            v-perm="'settings:write'"
            type="button"
            class="kbtn danger"
            @click="remove(detail)"
          >
            {{ $t('skills.kfcqesv') }}
          </button>
        </template>
      </template>
    </UiModal>

    <!-- 安装 -->
    <UiModal v-if="showInstall" :title="$t('skills.kxwmlqp')" :width="560" @close="showInstall = false">
      <div class="segmented install-tabs" role="tablist" :aria-label="$t('skills.k115jlxx')">
        <button
          type="button"
          role="tab"
          :aria-selected="install.kind === 'zip'"
          :class="{ on: install.kind === 'zip' }"
          @click="install.kind = 'zip'"
        >
          {{ $t('skills.kagup1y') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="install.kind === 'url'"
          :class="{ on: install.kind === 'url' }"
          @click="install.kind = 'url'"
        >
          GitHub / URL
        </button>
        <button
          v-if="!isServerMode"
          type="button"
          role="tab"
          :aria-selected="install.kind === 'folder'"
          :class="{ on: install.kind === 'folder' }"
          @click="install.kind = 'folder'"
        >
          {{ $t('skills.kt84lpf') }}
        </button>
      </div>
      <form id="skill-install-form" class="form-grid one" @submit.prevent="submitInstall">
        <template v-if="install.kind === 'zip'">
          <div class="field span-all">
            <span class="field-label">{{ $t('skills.k1neizmr') }}</span>
            <FilePick
              accept=".zip,application/zip"
              testid="skill-zip"
              :file-name="install.file?.name"
              @change="pickZip"
            />
          </div>
        </template>
        <template v-else-if="install.kind === 'url'">
          <label class="field span-all">
            <span class="field-label">{{ $t('skills.k2jtdi7') }}</span>
            <input v-model="install.url" class="input code" :placeholder="$t('skills.k13nspfq')" spellcheck="false" />
          </label>
        </template>
        <template v-else>
          <label class="field span-all">
            <span class="field-label">{{ $t('skills.k3yn2qn') }}</span>
            <input
              v-model="install.path"
              class="input code"
              placeholder="/Users/me/skills/my-skill"
              spellcheck="false"
            />
          </label>
        </template>
        <label v-if="install.kind !== 'folder'" class="field span-all">
          <span class="field-label">{{ $t('skills.kh9ht7a') }}</span>
          <input v-model="install.subpath" class="input code" placeholder="skills/pdf-tools" spellcheck="false" />
        </label>
        <label class="check span-all">
          <input v-model="install.overwrite" type="checkbox" /> {{ $t('skills.k7n7fp1') }}
        </label>
        <p class="hint span-all">
          {{ $t('skills.k148rnty') }}
        </p>
        <p v-if="install.error" class="field-error span-all" role="alert">
          {{ install.error }}
          <button
            v-if="install.conflict"
            type="button"
            class="link"
            @click="((install.overwrite = true), submitInstall())"
          >
            {{ $t('skills.k9srwcw') }}
          </button>
        </p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showInstall = false">{{ $t('skills.kldkknc') }}</button>
        <button type="submit" form="skill-install-form" class="kbtn primary" :disabled="install.saving">
          {{ install.saving ? $t('skills.k1qdj94f') : $t('skills.k2ctc1m') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.skills-panel {
  max-width: 1120px;
}
.skill-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.skill-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 22px;
  border-top: 1px solid var(--surface-muted);
}
.skill-row:first-child {
  border-top: 0;
}
.skill-row.off {
  background: var(--surface-soft);
}
.skill-row.off .skill-name,
.skill-row.off .skill-desc {
  color: var(--text-secondary);
}
.skill-main {
  flex: 1;
  min-width: 0;
}
.skill-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.skill-name {
  border: 0;
  background: none;
  padding: 0;
  min-height: 24px;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
}
.skill-name:hover {
  text-decoration: underline;
}
.skill-title .tag {
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.skill-desc {
  margin: 3px 0 4px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
  font-size: 12px;
  color: var(--text-tertiary);
  min-width: 0;
}
.skill-meta > span + span::before {
  content: '·';
  margin: 0 7px;
}
.skill-origin {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding-top: 4px;
}
.detail-note {
  margin-bottom: 12px;
}
.detail-desc {
  margin: 0 0 12px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.detail-tabs,
.install-tabs {
  margin-bottom: 14px;
}
.detail-doc {
  max-height: min(52vh, 520px);
  overflow: auto;
  padding: 4px 2px;
  font-size: 13.5px;
  line-height: 1.65;
}
.detail-files {
  display: grid;
  grid-template-columns: minmax(180px, 240px) 1fr;
  gap: 12px;
  min-height: 260px;
  max-height: min(52vh, 520px);
}
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
  padding-right: 8px;
}
.file-row {
  display: flex;
  width: 100%;
  gap: 8px;
  align-items: center;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.file-row:hover {
  background: var(--surface-hover);
}
.file-row.on {
  background: var(--surface-active);
  font-weight: 600;
}
.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.file-size {
  flex: none;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.file-view {
  min-width: 0;
  overflow: auto;
}
.file-code {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-meta {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 14px;
  margin: 0;
  font-size: 13px;
}
.detail-meta dt {
  color: var(--text-secondary);
}
.detail-meta dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.dim {
  color: var(--text-secondary);
  font-size: 13px;
}
@media (max-width: 1180px) {
  .skill-row {
    flex-wrap: wrap;
  }
  .skill-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
