<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { DENSITIES, SCALE_MAX, SCALE_MIN, THEMES, loadAppearance, saveAppearance } from '../lib/appearance'
import { loadLanguagePref, setLanguage, type LanguagePref } from '../i18n'

const state = reactive(loadAppearance())
watch(state, () => saveAppearance({ ...state }))

const language = ref<LanguagePref>(loadLanguagePref())
/** 语言名称用各自的语言写，任何界面语言下都认得出 */
const LANGUAGES: Array<{ value: LanguagePref; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'system', label: '' },
]
function chooseLanguage(value: LanguagePref): void {
  language.value = value
  setLanguage(value)
}
const step = (d: number) => (state.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, state.scale + d)))
const fillPct = () => ((state.scale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsAppearance.k2ozcmb')" :sub="$t('setx.appearanceSub')" />
    <div class="doc">
      <div class="doc-inner set-stack">
        <!-- 主题（三张预览缩略图） -->
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 id="theme-title" class="panel-title">{{ $t('settingsAppearance.k1sg85hw') }}</h2>
              <div class="panel-sub">{{ $t('setx.themeDesc') }}</div>
            </div>
          </div>
          <div class="tiles" role="radiogroup" aria-labelledby="theme-title" data-testid="theme">
            <button
              v-for="th in THEMES"
              :key="th"
              type="button"
              role="radio"
              class="tile"
              :aria-checked="state.theme === th"
              :class="{ on: state.theme === th }"
              @click="state.theme = th"
            >
              <span class="thumb" :class="th" aria-hidden="true">
                <span class="th-side"></span>
                <span class="th-main"> <i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> </span>
              </span>
              <span class="tile-foot">
                <span class="radio" aria-hidden="true"></span>
                <span>
                  <b>{{ $t(`settingsAppearance.theme_${th}`) }}</b>
                  <span class="tile-d">{{ state.theme === th ? $t('setx.current') : $t(`setx.themeHint_${th}`) }}</span>
                </span>
              </span>
            </button>
          </div>
        </section>

        <!-- 列表密度 -->
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 id="density-title" class="panel-title">{{ $t('setx.density') }}</h2>
              <div class="panel-sub">{{ $t('setx.densityDesc') }}</div>
            </div>
          </div>
          <div class="tiles" role="radiogroup" aria-labelledby="density-title" data-testid="density">
            <button
              v-for="d in DENSITIES"
              :key="d"
              type="button"
              role="radio"
              class="tile dens"
              :aria-checked="state.density === d"
              :class="[{ on: state.density === d }, d]"
              @click="state.density = d"
            >
              <span class="tile-foot top">
                <span class="radio" aria-hidden="true"></span>
                <b>{{ $t(`setx.density_${d}`) }}</b>
              </span>
              <span class="tile-d pad">{{ $t(`setx.densityHint_${d}`) }}</span>
              <span class="dlines" aria-hidden="true"><i></i><i></i><i></i></span>
            </button>
          </div>
        </section>

        <!-- 字号 -->
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 id="scale-title" class="panel-title">{{ $t('setx.fontSize') }}</h2>
              <div class="panel-sub">{{ $t('setx.fontSizeDesc') }}</div>
            </div>
          </div>
          <div class="scale-row">
            <button
              type="button"
              class="sbtn"
              :disabled="state.scale <= SCALE_MIN"
              :aria-label="$t('setx.smaller')"
              @click="step(-5)"
            >
              {{ $t('setx.small') }}
            </button>
            <input
              v-model.number="state.scale"
              class="slider"
              type="range"
              :min="SCALE_MIN"
              :max="SCALE_MAX"
              step="5"
              aria-labelledby="scale-title"
              :aria-valuetext="`${state.scale}%`"
              :style="{ '--fill': `${fillPct()}%` }"
              data-testid="scale"
            />
            <button
              type="button"
              class="sbtn"
              :disabled="state.scale >= SCALE_MAX"
              :aria-label="$t('setx.larger')"
              @click="step(5)"
            >
              {{ $t('setx.large') }}
            </button>
            <span class="sval">{{ state.scale }}%</span>
          </div>
          <div class="scale-ends" aria-hidden="true">
            <span>{{ SCALE_MIN }}%</span><span>{{ SCALE_MAX }}%</span>
          </div>
          <div class="row-item">
            <div class="grow">
              <div class="t">{{ $t('settingsAppearance.kuzngtq') }}</div>
              <div class="d">{{ $t('settingsAppearance.k11u6qzb') }}</div>
            </div>
            <UiSwitch v-model="state.reduceMotion" :label="$t('settingsAppearance.kuzngtq')" />
          </div>
        </section>

        <!-- 语言 -->
        <section class="panel">
          <div class="row-item">
            <div class="grow">
              <div id="lang-title" class="t">{{ $t('settingsAppearance.language') }}</div>
              <div class="d">{{ $t('settingsAppearance.languageDesc') }}</div>
            </div>
            <div class="segmented" role="radiogroup" aria-labelledby="lang-title" data-testid="language">
              <button
                v-for="l in LANGUAGES"
                :key="l.value"
                type="button"
                role="radio"
                :lang="l.value === 'system' ? undefined : l.value"
                :aria-checked="language === l.value"
                :class="{ on: language === l.value }"
                @click="chooseLanguage(l.value)"
              >
                {{ l.label || $t('settingsAppearance.languageSystem') }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.set-stack {
  display: flex;
  flex-direction: column;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 18px 22px 20px;
}
.tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.tile:hover {
  border-color: var(--text-tertiary);
}
.tile.on {
  border: 2px solid var(--text);
  margin: -1px;
}
.tile:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.thumb {
  height: 92px;
  display: flex;
  border-bottom: 1px solid var(--line);
  overflow: hidden;
}
.th-side {
  width: 26%;
  background: #f3f3f5;
  border-right: 1px solid #e8e8ea;
}
.th-main {
  flex: 1;
  background: #fff;
  padding: 10px 10px 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.th-main i {
  display: block;
  height: 4px;
  border-radius: 2px;
  background: #e6e6e9;
}
.th-main .l1 {
  width: 34%;
  background: #111113;
}
.th-main .l3 {
  width: 92%;
}
.th-main .l4 {
  width: 60%;
}
.thumb.dark .th-side {
  background: #1d1d20;
  border-right-color: #2a2a2e;
}
.thumb.dark .th-main {
  background: #121214;
}
.thumb.dark .th-main i {
  background: #2c2c31;
}
.thumb.dark .th-main .l1 {
  background: #f2f2f4;
}
.thumb.system .th-main {
  background: linear-gradient(90deg, #fff 0 50%, #121214 50% 100%);
}
.thumb.system .th-main i {
  background: linear-gradient(90deg, #e6e6e9 0 50%, #2c2c31 50% 100%);
}
.thumb.system .th-main .l1 {
  background: linear-gradient(90deg, #111113 0 50%, #f2f2f4 50% 100%);
}
.tile-foot {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px 14px;
  font-size: 13px;
}
.tile-foot.top {
  align-items: center;
  padding-bottom: 4px;
}
.tile-foot b {
  font-weight: 600;
}
.tile-d {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.tile-d.pad {
  margin: 0;
  padding: 0 14px;
}
.radio {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--line-strong);
}
.tile-foot.top .radio {
  margin-top: 0;
}
.tile.on .radio {
  box-shadow: inset 0 0 0 4px var(--text);
}
.dens {
  padding-bottom: 16px;
}
.dlines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 14px 0;
}
.dlines i {
  display: block;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-muted);
}
.dlines i:last-child {
  width: 64%;
}
.dens.compact .dlines {
  gap: 3px;
}
.dens.comfortable .dlines {
  gap: 10px;
}
.scale-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 22px 0;
}
.sbtn {
  width: 34px;
  height: 32px;
  flex: none;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
}
.sbtn:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-hover);
}
.sbtn:disabled {
  opacity: 0.45;
}
.slider {
  flex: 1;
  min-width: 0;
  height: 18px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}
.slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--text) 0 var(--fill), var(--surface-muted) var(--fill) 100%);
}
.slider::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--text) 0 var(--fill), var(--surface-muted) var(--fill) 100%);
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 1px 3px rgb(0 0 0 / 0.15);
}
.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 1px 3px rgb(0 0 0 / 0.15);
}
.slider:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 4px;
  border-radius: 4px;
}
.sval {
  width: 48px;
  text-align: right;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.scale-ends {
  display: flex;
  justify-content: space-between;
  padding: 10px 22px 16px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.panel > .row-item:first-child {
  border-top: 0;
}
@media (max-width: 1100px) {
  .tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
