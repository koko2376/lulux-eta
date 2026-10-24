<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import logoUrl from '../assets/lulux-neutral.png'
import { downloadServerLogs, getHealth } from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import ThirdPartyLicenses from '../components/ThirdPartyLicenses.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import {
  APP_NAME,
  AUTHOR,
  AUTHOR_EMAIL,
  authorLocation,
  DOWNLOAD_PAGE,
  LICENSE_CHANGE_DATE,
  LICENSE_CHANGE_LICENSE,
  LICENSE_LICENSOR,
  LICENSE_NAME,
  LICENSE_POINTS,
  REPO_URL,
} from '../lib/about'
import {
  formatDate,
  formatMB,
  formatSpeed,
  getUpdater,
  limitationText,
  relativeTime,
  updateErrorText,
  updater,
  useUpdaterSubscription,
  type UpdateChannel,
  type UpdaterSettings,
} from '../lib/updater'
import { getDesktop } from '../lib/desktop'
import { downloadBlob } from '../lib/download'
import { auth, can } from '../lib/session'
import { openExternal } from '../lib/window'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const version = __APP_VERSION__
const desktop = typeof window !== 'undefined' ? window.luluxAgent : undefined
const bridge = getUpdater()
const serviceOk = ref<boolean | null>(null)
const busy = ref(false)
const showLicenses = ref(false)
const now = ref(Date.now())
let release: () => void = () => undefined
let timer = 0

const state = computed(() => updater.state)
const settings = computed(() => updater.settings)
const currentVersion = computed(() => state.value?.currentVersion || version)
const sourceText = computed(() => {
  const s = state.value?.source
  if (!s) return t('settingsAbout.krkdc45')
  return s.provider === 'github' ? `GitHub · ${s.repo}` : s.url
})
const percent = computed(() => Math.max(0, Math.min(100, state.value?.progress?.percent ?? 0)))
const canAutoInstall = computed(() => state.value?.canAutoInstall !== false)
const customFeed = computed(() => state.value?.source?.provider === 'generic' && state.value.source.custom === true)
const errorSummary = computed(() => updateErrorText(state.value?.lastError ?? null, customFeed.value))

/* ── 更新源地址（generic，可选） ── */
const feedSupported = computed(
  () => settings.value !== null && settings.value !== undefined && 'feedUrl' in settings.value,
)
const feedDraft = ref('')
const feedSaving = ref(false)
const feedError = ref('')
function syncFeedDraft(): void {
  feedDraft.value = settings.value?.feedUrl ?? ''
}
async function saveFeed(value: string): Promise<void> {
  if (!bridge || feedSaving.value) return
  feedSaving.value = true
  feedError.value = ''
  try {
    updater.settings = await bridge.setSettings({ feedUrl: value.trim() || null })
    syncFeedDraft()
    toast.success(value.trim() ? t('ops.feedSaved') : t('ops.feedCleared'))
  } catch (error) {
    feedError.value = errorText(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    feedSaving.value = false
  }
}

/* ── 诊断 ── */
const desktopTools = getDesktop()
const canDownloadServerLogs = computed(() => auth.mode === 'server' && can('audit:read'))
const diagBusy = ref(false)
async function openLogs(): Promise<void> {
  if (!desktopTools) return
  const ok = await desktopTools.openLogsDir().catch(() => false)
  if (!ok) toast.error(t('ops.openLogsFailed'))
}
async function exportDiagnostics(): Promise<void> {
  if (!desktopTools || diagBusy.value) return
  diagBusy.value = true
  try {
    const result = await desktopTools.exportDiagnostics()
    if (result.ok) toast.success(t('ops.diagExported', [result.path ?? '']))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    diagBusy.value = false
  }
}
async function serverLogs(): Promise<void> {
  if (diagBusy.value) return
  diagBusy.value = true
  try {
    const blob = await downloadServerLogs(3)
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    downloadBlob(blob, `lulux-server-logs-${stamp}.zip`)
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    diagBusy.value = false
  }
}
const limitation = computed(() => limitationText(state.value?.limitation ?? null))

watch(() => settings.value?.feedUrl, syncFeedDraft, { immediate: true })

onMounted(async () => {
  release = useUpdaterSubscription()
  timer = window.setInterval(() => (now.value = Date.now()), 30_000)
  try {
    serviceOk.value = (await getHealth()).ok === true
  } catch {
    serviceOk.value = false
  }
})
onBeforeUnmount(() => {
  release()
  window.clearInterval(timer)
})

async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await action()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}

function check(): Promise<void> {
  return run(async () => {
    updater.state = await bridge!.check()
  })
}
function download(): Promise<void> {
  return run(async () => {
    updater.state = await bridge!.download()
  })
}
function install(): Promise<void> {
  return run(() => bridge!.install())
}

async function patch(p: Partial<UpdaterSettings>): Promise<void> {
  if (!bridge) return
  try {
    updater.settings = await bridge.setSettings(p)
  } catch (error) {
    toast.error(errorText(error))
  }
}
function setChannel(channel: UpdateChannel): void {
  if (settings.value?.channel !== channel) void patch({ channel })
}

function openDownloadPage(): void {
  openExternal(state.value?.downloadPage || DOWNLOAD_PAGE)
}
function openLink(event: MouseEvent, url: string): void {
  event.preventDefault()
  openExternal(url)
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsAbout.k2i0f5l')" />
    <div class="doc">
      <div class="doc-inner">
        <section class="panel about-hero">
          <img :src="logoUrl" :alt="$t('settingsAbout.kkdd6fu')" class="logo" width="56" height="56" />
          <div class="grow">
            <h2 class="hero-name">{{ APP_NAME }}</h2>
            <p class="hero-sub">{{ $t('settingsAbout.k1q6bjt3') }}</p>
          </div>
          <div class="hero-ver">
            <span class="ver mono" data-testid="about-version">v{{ currentVersion }}</span>
            <span v-if="settings?.channel === 'beta'" class="tag">{{ $t('settingsAbout.k9da6cu') }}</span>
          </div>
        </section>

        <!-- 软件更新：桌面端 -->
        <section v-if="bridge" class="panel" aria-labelledby="upd-title">
          <div class="panel-head">
            <div class="txt">
              <h2 id="upd-title" class="panel-title">{{ $t('settingsAbout.kz27cb5') }}</h2>
              <p class="panel-sub">
                {{ $t('settingsAbout.k13lwsut', [relativeTime(state?.lastCheckedAt ?? null, now)])
                }}<span class="mono">{{ sourceText }}</span>
              </p>
            </div>
          </div>

          <div class="row-item upd-row" role="status" aria-live="polite">
            <div class="grow">
              <template v-if="!state">
                <div class="t">{{ $t('settingsAbout.k1oz4qjq') }}</div>
              </template>
              <template v-else-if="state.status === 'checking'">
                <div class="t"><span class="spinner" aria-hidden="true"></span>{{ $t('settingsAbout.k1jp6kxl') }}</div>
              </template>
              <template v-else-if="state.status === 'available' && state.available">
                <div class="t">
                  {{ $t('settingsAbout.ka5ukk') }} <span class="mono">v{{ state.available.version }}</span>
                  <span v-if="state.available.prerelease" class="tag">{{ $t('settingsAbout.ktvqkp8') }}</span>
                </div>
                <div class="d">
                  <span v-if="state.available.releaseDate">{{
                    $t('settingsAbout.k1psbfm6', [formatDate(state.available.releaseDate)])
                  }}</span>
                  <span v-if="!canAutoInstall && limitation"> · {{ limitation }}</span>
                </div>
              </template>
              <template v-else-if="state.status === 'downloading'">
                <div class="t">
                  {{ $t('settingsAbout.k10he92t') }}
                  <span v-if="state.available" class="mono">v{{ state.available.version }}</span>
                </div>
                <div
                  class="progress-bar upd-progress"
                  role="progressbar"
                  :aria-label="$t('settingsAbout.k1vn9pmc')"
                  :aria-valuenow="Math.round(percent)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <i :style="{ width: `${percent}%` }"></i>
                </div>
                <div class="d mono">
                  {{ Math.round(percent) }}% · {{ formatMB(state.progress?.transferred ?? 0) }} /
                  {{ formatMB(state.progress?.total ?? 0) }}
                  <span v-if="formatSpeed(state.progress?.bytesPerSecond ?? 0)">
                    · {{ formatSpeed(state.progress?.bytesPerSecond ?? 0) }}</span
                  >
                </div>
              </template>
              <template v-else-if="state.status === 'downloaded'">
                <div class="t">
                  {{ $t('settingsAbout.k1d18m4o') }}
                  <span v-if="state.available" class="mono">v{{ state.available.version }}</span>
                  {{ $t('settingsAbout.kbsc2hc') }}
                </div>
                <div class="d">{{ $t('settingsAbout.kllq7we') }}</div>
              </template>
              <template v-else-if="state.status === 'error' && state.lastError">
                <div class="t err">{{ $t('settingsAbout.k13tp3w0') }}</div>
                <div class="d" data-testid="update-error">{{ errorSummary }}</div>
                <div v-if="errorSummary !== state.lastError.message" class="d faint mono">
                  {{ state.lastError.message }}
                </div>
              </template>
              <template v-else-if="state.status === 'not-available'">
                <div class="t"><span class="ok-dot" aria-hidden="true"></span>{{ $t('settingsAbout.k1qf6695') }}</div>
              </template>
              <template v-else-if="!state.canCheck">
                <div class="t">{{ $t('settingsAbout.k134vr1u') }}</div>
                <div class="d">{{ limitation || $t('settingsAbout.km4iaj9') }}</div>
              </template>
              <template v-else>
                <div class="t">
                  {{ $t('settingsAbout.kjo79er') }} <span class="mono">v{{ currentVersion }}</span>
                </div>
              </template>
              <div v-if="state?.lastError && !state.lastError.interactive && state.status !== 'error'" class="d faint">
                {{ $t('settingsAbout.kn43t48', [errorSummary]) }}
              </div>
            </div>
            <div class="panel-actions">
              <template v-if="state?.status === 'available'">
                <button v-if="canAutoInstall" type="button" class="kbtn primary" :disabled="busy" @click="download">
                  {{ $t('settingsAbout.kc3n2up') }}
                </button>
                <button v-else type="button" class="kbtn primary" @click="openDownloadPage">
                  {{ $t('settingsAbout.k89kfqd') }}
                </button>
              </template>
              <template v-else-if="state?.status === 'downloaded'">
                <button type="button" class="kbtn primary" :disabled="busy" @click="install">
                  {{ $t('settingsAbout.ke7148j') }}
                </button>
              </template>
              <button v-else-if="state?.status === 'error'" type="button" class="kbtn" :disabled="busy" @click="check">
                {{ $t('settingsAbout.k1qxrqzx') }}
              </button>
              <button
                v-if="state?.status !== 'downloaded' && state?.status !== 'downloading'"
                type="button"
                class="kbtn"
                :disabled="busy || !state || !state.canCheck || state.status === 'checking'"
                :title="state && !state.canCheck ? limitation : undefined"
                @click="check"
              >
                {{ state?.status === 'checking' ? $t('settingsAbout.kqko1rp') : $t('settingsAbout.k1aau5aw') }}
              </button>
            </div>
          </div>

          <div v-if="state?.available?.notes" class="row-item notes-row">
            <details class="notes" open>
              <summary>
                {{ $t('settingsAbout.kue0vs7')
                }}<span v-if="state.available.releaseName"> · {{ state.available.releaseName }}</span>
              </summary>
              <pre class="notes-text" data-testid="release-notes">{{ state.available.notes }}</pre>
              <a
                v-if="state.downloadPage"
                class="link"
                :href="state.downloadPage"
                @click="openLink($event, state.downloadPage)"
                >{{ $t('settingsAbout.k1w5ye6l') }}</a
              >
            </details>
          </div>

          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsAbout.k1w2a7js') }}</div>
              <div class="d">{{ $t('settingsAbout.k30fdf1') }}</div>
            </div>
            <UiSwitch
              :model-value="settings?.autoCheck ?? false"
              :label="$t('settingsAbout.k1w2a7js')"
              :disabled="!settings"
              @update:model-value="patch({ autoCheck: $event })"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsAbout.k1x2elcf') }}</div>
              <div class="d">
                {{
                  canAutoInstall
                    ? $t('settingsAbout.k1rlwvwd')
                    : $t('settingsAbout.k1egy31f', [limitation || $t('settingsAbout.k1jjuj70')])
                }}
              </div>
            </div>
            <UiSwitch
              :model-value="settings?.autoDownload ?? false"
              :label="$t('settingsAbout.k1x2elcf')"
              :disabled="!settings || !canAutoInstall"
              @update:model-value="patch({ autoDownload: $event })"
            />
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsAbout.k142xyyl') }}</div>
              <div class="d">{{ $t('settingsAbout.kbz35n0') }}</div>
            </div>
            <div class="segmented" role="radiogroup" :aria-label="$t('settingsAbout.k142xyyl')">
              <button
                type="button"
                role="radio"
                :aria-checked="settings?.channel === 'stable'"
                :class="{ on: settings?.channel === 'stable' }"
                :disabled="!settings"
                @click="setChannel('stable')"
              >
                {{ $t('settingsAbout.ksh46re') }}
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="settings?.channel === 'beta'"
                :class="{ on: settings?.channel === 'beta' }"
                :disabled="!settings"
                @click="setChannel('beta')"
              >
                {{ $t('settingsAbout.ktvqkp8') }}
              </button>
            </div>
          </div>
          <div v-if="feedSupported" class="row-item feed-row" data-testid="update-feed">
            <div class="grow">
              <div class="t">{{ $t('ops.feedTitle') }}</div>
              <div class="d">{{ $t('ops.feedHint') }}</div>
              <div class="feed-edit">
                <input
                  v-model="feedDraft"
                  class="input code"
                  name="updateFeedUrl"
                  :placeholder="$t('ops.feedPlaceholder')"
                  :aria-label="$t('ops.feedTitle')"
                  :disabled="feedSaving"
                  @keydown.enter="saveFeed(feedDraft)"
                />
                <button
                  type="button"
                  class="kbtn"
                  :disabled="feedSaving || feedDraft.trim() === (settings?.feedUrl ?? '')"
                  @click="saveFeed(feedDraft)"
                >
                  {{ $t('ops.feedSave') }}
                </button>
                <button
                  v-if="settings?.feedUrl"
                  type="button"
                  class="kbtn"
                  :disabled="feedSaving"
                  @click="saveFeed('')"
                >
                  {{ $t('ops.feedReset') }}
                </button>
              </div>
              <p v-if="feedError" class="field-error" role="alert">{{ feedError }}</p>
            </div>
          </div>
        </section>

        <!-- 浏览器 / 远程模式：没有自动更新 -->
        <section v-else class="panel" aria-labelledby="upd-title">
          <div class="row-item">
            <div class="grow">
              <h2 id="upd-title" class="t">{{ $t('settingsAbout.kzztw4d') }}</h2>
              <div class="d">{{ $t('settingsAbout.k1dr09fk') }}</div>
            </div>
            <button type="button" class="kbtn primary" @click="openDownloadPage">
              {{ $t('settingsAbout.k89kfqd') }}
            </button>
          </div>
        </section>

        <section
          v-if="desktopTools || canDownloadServerLogs"
          class="panel"
          aria-labelledby="diag-title"
          data-testid="diagnostics"
        >
          <div class="panel-head">
            <div class="txt">
              <h2 id="diag-title" class="panel-title">{{ $t('ops.diagTitle') }}</h2>
              <p class="panel-sub">{{ $t('ops.diagSub') }}</p>
            </div>
          </div>
          <div v-if="desktopTools" class="row-item">
            <div class="grow">
              <div class="t">{{ $t('ops.diagLocal') }}</div>
              <div class="d">{{ $t('ops.diagLocalHint') }}</div>
            </div>
            <div class="panel-actions">
              <button type="button" class="kbtn" data-testid="open-logs" @click="openLogs">
                {{ $t('ops.openLogs') }}
              </button>
              <button
                type="button"
                class="kbtn primary"
                data-testid="export-diagnostics"
                :disabled="diagBusy"
                @click="exportDiagnostics"
              >
                {{ $t('ops.exportDiagnostics') }}
              </button>
            </div>
          </div>
          <div v-if="canDownloadServerLogs" class="row-item">
            <div class="grow">
              <div class="t">{{ $t('ops.serverLogs') }}</div>
              <div class="d">{{ $t('ops.serverLogsHint') }}</div>
            </div>
            <button type="button" class="kbtn" data-testid="server-logs" :disabled="diagBusy" @click="serverLogs">
              {{ $t('ops.downloadServerLogs') }}
            </button>
          </div>
        </section>

        <section class="panel" aria-labelledby="author-title">
          <div class="panel-head">
            <div class="txt">
              <h2 id="author-title" class="panel-title">{{ $t('settingsAbout.knfezvo') }}</h2>
            </div>
          </div>
          <dl class="kv">
            <div>
              <dt>{{ $t('settingsAbout.kta9wep') }}</dt>
              <dd>{{ AUTHOR }} · {{ authorLocation() }}</dd>
            </div>
            <div>
              <dt>{{ $t('settingsAbout.k1usbw8n') }}</dt>
              <dd>
                <a class="link" :href="`mailto:${AUTHOR_EMAIL}`">{{ AUTHOR_EMAIL }}</a>
              </dd>
            </div>
            <div>
              <dt>{{ $t('settingsAbout.kw6sjbt') }}</dt>
              <dd>
                <a class="link" :href="REPO_URL" @click="openLink($event, REPO_URL)">{{
                  REPO_URL.replace('https://', '')
                }}</a>
              </dd>
            </div>
          </dl>
        </section>

        <section class="panel" aria-labelledby="license-title">
          <div class="panel-head">
            <div class="txt">
              <h2 id="license-title" class="panel-title">{{ $t('settingsAbout.k1k56eop') }}</h2>
              <p class="panel-sub">
                <span data-testid="license-name">{{ LICENSE_NAME }}</span>
                {{ $t('settingsAbout.k1jw1050', [LICENSE_LICENSOR, LICENSE_CHANGE_DATE, LICENSE_CHANGE_LICENSE]) }}
              </p>
            </div>
            <button type="button" class="kbtn" @click="showLicenses = true">{{ $t('settingsAbout.k1frlde3') }}</button>
          </div>
          <ul class="license-points">
            <li v-for="point in LICENSE_POINTS" :key="point">{{ point }}</li>
          </ul>
        </section>

        <section class="panel" :aria-label="$t('settingsAbout.k1vqt3gd')">
          <dl class="kv">
            <div>
              <dt>{{ $t('settingsAbout.k16ceynz') }}</dt>
              <dd class="mono">{{ currentVersion }}</dd>
            </div>
            <div>
              <dt>{{ $t('settingsAbout.k1vqt3gd') }}</dt>
              <dd>
                {{ desktop ? $t('settingsAbout.k5qfguv', [desktop.platform]) : $t('settingsAbout.k11yttjx')
                }}<span v-if="state?.arch"> · {{ state.arch }}</span>
              </dd>
            </div>
            <template v-if="desktop?.versions">
              <div>
                <dt>Electron</dt>
                <dd class="mono">{{ desktop.versions.electron }}</dd>
              </div>
              <div>
                <dt>Chromium</dt>
                <dd class="mono">{{ desktop.versions.chrome }}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd class="mono">{{ desktop.versions.node }}</dd>
              </div>
            </template>
            <div>
              <dt>{{ $t('settingsAbout.k1rnk1gf') }}</dt>
              <dd>
                <span v-if="serviceOk === null" class="muted">{{ $t('settingsAbout.kqko1rp') }}</span>
                <span v-else-if="serviceOk" class="badge-on">{{ $t('settingsAbout.korkz1s') }}</span>
                <span v-else class="badge-bad">{{ $t('settingsAbout.k5y7iw2') }}</span>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
    <ThirdPartyLicenses v-if="showLicenses" @close="showLicenses = false" />
  </main>
</template>

<style scoped>
.about-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface-soft) 100%);
}
.logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  flex: none;
}
.grow {
  flex: 1;
  min-width: 0;
}
.hero-name {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.hero-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.hero-ver {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.ver {
  font-size: 13px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text);
}
.mono {
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  font-variant-numeric: tabular-nums;
}
.upd-row {
  align-items: flex-start;
}
.upd-progress {
  margin: 10px 0 6px;
  max-width: 420px;
}
.err {
  color: var(--danger-text);
}
.faint {
  color: var(--text-tertiary, var(--text-secondary));
}
.ok-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--good);
  display: inline-block;
}
.spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--text);
  display: inline-block;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.notes-row {
  display: block;
}
.feed-row {
  align-items: flex-start;
}
.feed-edit {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  max-width: 560px;
}
.feed-edit .input {
  flex: 1;
  min-width: 0;
}
.notes summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.notes-text {
  margin: 10px 0;
  padding: 12px 14px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.7;
  background: var(--surface-soft);
  border-radius: 8px;
}
.kv {
  margin: 0;
}
.kv div {
  display: flex;
  gap: 16px;
  padding: 12px 20px;
  border-top: 1px solid var(--surface-muted);
  font-size: 13px;
}
.kv div:first-child {
  border-top: 0;
}
.kv dt {
  width: 120px;
  flex: none;
  color: var(--text-secondary);
}
.kv dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.kv dd .link,
.notes .link {
  font-size: 13px;
  color: var(--text);
  text-decoration: underline;
  text-decoration-color: var(--line-strong);
  text-underline-offset: 3px;
}
.kv dd .link:hover,
.notes .link:hover {
  text-decoration-color: currentColor;
}
.license-points {
  margin: 0;
  padding: 14px 20px 16px 38px;
  font-size: 13px;
  line-height: 1.85;
}
</style>
