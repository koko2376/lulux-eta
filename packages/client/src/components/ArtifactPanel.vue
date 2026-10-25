<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  artifactFileName,
  extractArtifacts,
  isPreviewable,
  languageLabel,
  normalizeLanguage,
  previewSource,
  type Artifact,
} from '../lib/artifacts'
import * as sk from '../api/skills'
import { copyText } from '../lib/clipboard'
import { downloadBlob, formatBytes } from '../lib/download'
import { fileKind } from '../lib/artifacts'
import { useAppStore, type FileArtifact } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import AppIcon from './AppIcon.vue'
import { t } from '../i18n'

const emit = defineEmits<{ close: [] }>()

const store = useAppStore()
const selectedId = ref<string | null>(null)
const copied = ref(false)
let copiedTimer = 0

/** 生成中的回复也参与提取，artifact 事件到达后可以立即预览 */
const artifacts = computed(() => {
  const list = [...store.messages]
  if (store.streamText && store.currentSessionId) {
    list.push({
      id: 'streaming',
      sessionId: store.currentSessionId,
      role: 'assistant',
      content: store.streamText,
      senderAgentId: store.streamingAgentId,
      toolTrace: [],
      createdAt: Date.now(),
    })
  }
  return extractArtifacts(list)
})
const selected = computed(() => artifacts.value.find((item) => item.id === selectedId.value) ?? null)

/* 会话工作区里的文件（脚本生成的 docx/xlsx/pptx/pdf、上传的附件）：binary 产物 downloadUrl 下载 */
const workspaceFiles = ref<sk.WorkspaceEntry[]>([])
const highlightPath = ref<string | null>(null)
async function loadFiles(): Promise<void> {
  const id = store.currentSessionId
  if (!id) return void (workspaceFiles.value = [])
  const entries = await sk.listSessionFiles(id).catch(() => [])
  if (store.currentSessionId === id) workspaceFiles.value = entries.filter((e) => e.type === 'file')
}
watch(() => [store.currentSessionId, store.streaming], loadFiles, { immediate: true })

const files = computed<FileArtifact[]>(() => {
  const id = store.currentSessionId
  if (!id) return []
  const map = new Map<string, FileArtifact>()
  for (const entry of workspaceFiles.value) {
    map.set(entry.path, {
      path: entry.path,
      title: entry.path.split('/').pop() || entry.path,
      size: entry.size,
      mime: '',
      downloadUrl: sk.sessionFileUrl(id, entry.path),
      createdAt: Date.parse(entry.modifiedAt) || 0,
    })
  }
  for (const item of store.fileArtifacts[id] ?? []) map.set(item.path, { ...map.get(item.path), ...item })
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
})

const downloading = ref<string | null>(null)
async function downloadFile(file: FileArtifact): Promise<void> {
  downloading.value = file.path
  try {
    downloadBlob(await sk.fetchDownload(file.downloadUrl), file.title)
  } catch (error) {
    toast.error(t('artifactPanel.kn7vjo8', [errorText(error)]))
  } finally {
    downloading.value = null
  }
}

/* artifact 事件（契约 §6.8-8）：打开面板并定位到新产物 */
const pendingFocus = ref<{ language: string; title: string } | null>(null)
watch(
  () => store.artifactFocus,
  (focus) => {
    if (!focus || focus.sessionId !== store.currentSessionId) return
    store.artifactFocus = null
    if (focus.path) {
      selectedId.value = null
      highlightPath.value = focus.path
      void loadFiles()
      return
    }
    pendingFocus.value = { language: normalizeLanguage(focus.language), title: focus.title }
  },
  { immediate: true },
)
watch(
  [artifacts, pendingFocus],
  () => {
    const focus = pendingFocus.value
    if (!focus) return
    const match = [...artifacts.value].reverse().find((a) => a.language === focus.language)
    if (!match) return
    selectedId.value = match.id
    if (match.messageId !== 'streaming') pendingFocus.value = null
  },
  { immediate: true },
)

// 切换会话后回到列表，避免展示上一个会话的产物
watch(
  () => store.currentSessionId,
  () => {
    selectedId.value = null
  },
)

function open(artifact: Artifact): void {
  selectedId.value = artifact.id
}

function lineCount(code: string): number {
  return code.split('\n').length
}

async function copyArtifact(): Promise<void> {
  if (!selected.value) return
  const code = selected.value.code
  const ok = await copyText(code)
  copied.value = ok
  if (!ok) return
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
  }, 1600)
}

function downloadArtifact(): void {
  const artifact = selected.value
  if (!artifact) return
  const type = artifact.language === 'html' || artifact.language === 'svg' ? 'text/html' : 'text/plain'
  const blob = new Blob([artifact.code], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = artifactFileName(artifact)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <aside class="tool-panel artifact-panel">
    <header class="tool-panel-header">
      <button
        type="button"
        class="icon-button"
        :title="$t('artifactPanel.k5x13zv')"
        :aria-label="$t('artifactPanel.k5x13zv')"
        @click="emit('close')"
      >
        <AppIcon name="chevron-left" :size="18" />
      </button>
      <div class="tool-panel-heading">
        <strong>{{ $t('artifactPanel.k4dl4ov') }}</strong>
        <span>{{
          $t('artifactPanel.k19wgblj', [
            artifacts.length,
            files.length ? $t('artifactPanel.k100z7ll', [files.length]) : '',
          ])
        }}</span>
      </div>
    </header>

    <template v-if="selected">
      <div class="artifact-view">
        <div class="artifact-view-bar">
          <button
            type="button"
            class="icon-button"
            :title="$t('artifactPanel.k1slpnvr')"
            :aria-label="$t('artifactPanel.k1slpnvr')"
            @click="selectedId = null"
          >
            <AppIcon name="chevron-left" :size="17" />
          </button>
          <div class="artifact-view-title">
            <strong>{{ selected.title }}</strong>
            <span>{{
              $t('artifactPanel.k1hdxlbj', [languageLabel(selected.language), lineCount(selected.code)])
            }}</span>
          </div>
          <button
            type="button"
            class="icon-button"
            :title="copied ? $t('artifactPanel.k1r4hxti') : $t('artifactPanel.kgekt3h')"
            @click="copyArtifact"
          >
            <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
          </button>
          <button
            type="button"
            class="icon-button"
            :title="$t('artifactPanel.kbew8qj')"
            :aria-label="$t('artifactPanel.kbew8qj')"
            @click="downloadArtifact"
          >
            <AppIcon name="download" :size="16" />
          </button>
        </div>

        <div class="artifact-preview">
          <iframe
            v-if="isPreviewable(selected.language)"
            :srcdoc="previewSource(selected)"
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            :title="$t('artifactPanel.ka1jehi')"
          />
          <p v-if="isPreviewable(selected.language)" class="artifact-sandbox-note">
            {{ $t('artifactPanel.k1pc46d4') }}
          </p>
          <pre v-else class="artifact-code">{{ previewSource(selected) }}</pre>
        </div>
      </div>
    </template>

    <div v-else-if="artifacts.length || files.length" class="artifact-list">
      <template v-if="files.length">
        <h3 class="artifact-section">{{ $t('artifactPanel.kkhv5od') }}</h3>
        <div
          v-for="file in files"
          :key="file.path"
          class="artifact-card file-card"
          :class="{ fresh: highlightPath === file.path }"
          :data-path="file.path"
        >
          <span class="artifact-lang" :class="`kind-${fileKind(file.path)}`">{{
            fileKind(file.path).toUpperCase()
          }}</span>
          <span class="artifact-main">
            <strong class="artifact-title" :title="file.path">{{ file.title }}</strong>
            <span class="artifact-meta" :title="file.path">{{ formatBytes(file.size) }} · {{ file.path }}</span>
          </span>
          <button
            type="button"
            class="icon-button"
            :title="$t('artifactPanel.keq782b', [file.title])"
            :aria-label="$t('artifactPanel.keq782b', [file.title])"
            :disabled="downloading === file.path"
            @click="downloadFile(file)"
          >
            <AppIcon name="download" :size="16" />
          </button>
        </div>
        <h3 v-if="artifacts.length" class="artifact-section">{{ $t('artifactPanel.k1pkjx2b') }}</h3>
      </template>
      <button
        v-for="artifact in artifacts"
        :key="artifact.id"
        type="button"
        class="artifact-card"
        @click="open(artifact)"
      >
        <span class="artifact-lang">{{ languageLabel(artifact.language) }}</span>
        <span class="artifact-main">
          <strong class="artifact-title">{{ artifact.title }}</strong>
          <span class="artifact-meta">{{ $t('artifactPanel.kh5h6jr', [lineCount(artifact.code)]) }}</span>
        </span>
        <AppIcon name="chevron-right" :size="15" class="artifact-arrow" />
      </button>
    </div>

    <div v-else class="artifact-empty">
      <span class="artifact-empty-icon"><AppIcon name="code" :size="24" /></span>
      <strong>{{ $t('artifactPanel.kghccpf') }}</strong>
      <p>
        {{ $t('artifactPanel.k1mq1mds') }}
      </p>
    </div>
  </aside>
</template>
