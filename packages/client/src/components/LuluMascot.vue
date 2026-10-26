<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 吉祥物露露：站在输入框上沿。
 * - idle：轻微呼吸 + 隔几秒眨眼；
 * - typing：跟着光标走（x 由父组件给），小碎步；
 * - thinking：LULUX 生成中，“思考”表情，原地踱步；
 * - happy：一轮回复完成，眯眼笑 + 跳一下；
 * - wow：出错时睁大眼。
 * 纯 SVG + CSS 动画；“减少动态效果”开启时只换表情、不走动不跳。
 */
export type LuluState = 'idle' | 'typing' | 'thinking' | 'happy' | 'wow'

const props = withDefaults(defineProps<{ state?: LuluState; x?: number; reduceMotion?: boolean }>(), {
  state: 'idle',
  x: 24,
  reduceMotion: false,
})

const blinking = ref(false)
const waving = ref(false)
let blinkTimer: ReturnType<typeof setTimeout> | null = null
let waveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleBlink(): void {
  blinkTimer = setTimeout(
    () => {
      // 减少动态效果时不眨眼
      if (props.reduceMotion) return scheduleBlink()
      blinking.value = true
      blinkTimer = setTimeout(() => {
        blinking.value = false
        scheduleBlink()
      }, 140)
    },
    2800 + Math.random() * 3200,
  )
}

onMounted(scheduleBlink)
onBeforeUnmount(() => {
  if (blinkTimer) clearTimeout(blinkTimer)
  if (waveTimer) clearTimeout(waveTimer)
})

function wave(): void {
  waving.value = true
  if (waveTimer) clearTimeout(waveTimer)
  waveTimer = setTimeout(() => (waving.value = false), 1200)
}

/** 走路方向：x 变大朝右看，变小朝左看 */
const facing = ref<1 | -1>(1)
watch(
  () => props.x,
  (next, prev) => {
    if (prev === undefined || Math.abs(next - prev) < 2) return
    facing.value = next > prev ? 1 : -1
  },
)

const face = computed(() => {
  if (props.state === 'happy') return 'happy'
  if (props.state === 'wow') return 'wow'
  if (props.state === 'thinking') return blinking.value ? 'blink' : 'think'
  return blinking.value ? 'blink' : 'lu'
})
const walking = computed(() => !props.reduceMotion && (props.state === 'typing' || props.state === 'thinking'))
/** 眼睛朝走的方向偏一点 */
const look = computed(() => (props.state === 'typing' ? facing.value * 1.6 : 0))
</script>

<template>
  <div
    class="lulu"
    :class="[`s-${state}`, { walking, waving, still: reduceMotion }]"
    :style="{ transform: `translateX(${x}px)` }"
    aria-hidden="true"
    data-testid="lulu"
  >
    <svg class="lulu-svg" viewBox="0 0 100 74" width="58" height="43" @click="wave">
      <g class="lulu-jump">
        <g class="lulu-body">
          <!-- 腿：四条短腿，走路时前后两组交替抬 -->
          <g class="legs">
            <line class="leg la" x1="31" y1="57" x2="31" y2="68" />
            <line class="leg lb" x1="42.5" y1="56" x2="42.5" y2="68" />
            <line class="leg la" x1="57.5" y1="54" x2="57.5" y2="68" />
            <line class="leg lb" x1="69" y1="52" x2="69" y2="68" />
          </g>
          <!-- 两只小手 -->
          <line class="arm arm-l" x1="21" y1="41" x2="14" y2="43.5" />
          <line class="arm arm-r" x1="78.5" y1="37" x2="85" y2="38" />
          <!-- 身体：胶囊，-8° -->
          <rect class="torso" x="20" y="18" width="60" height="40" rx="20" transform="rotate(-8 50 38)" />
          <!-- 眼睛 -->
          <g class="eyes" :transform="`translate(${look} 0) rotate(-12 51 38)`">
            <template v-if="face === 'lu'">
              <line class="eye" x1="41" y1="28.5" x2="41" y2="41.5" />
              <path class="eye" d="M54 34.5 V39.6 a4 4 0 0 0 8 0 V34.5 M62 34.5 V44.6" />
            </template>
            <template v-else-if="face === 'blink'">
              <line class="eye" x1="37.5" y1="39.5" x2="44.5" y2="39.5" />
              <line class="eye" x1="54.5" y1="41.5" x2="61.5" y2="41.5" />
            </template>
            <template v-else-if="face === 'think'">
              <line class="eye" x1="41" y1="28.5" x2="41" y2="41.5" />
              <line class="eye" x1="54.5" y1="41.5" x2="61.5" y2="41.5" />
            </template>
            <template v-else-if="face === 'happy'">
              <path class="eye" d="M37 39.5 a4 4 0 0 1 8 0" />
              <path class="eye" d="M54 41.5 a4 4 0 0 1 8 0" />
            </template>
            <template v-else>
              <ellipse class="eye-o" cx="41" cy="37" rx="4.3" ry="4.9" />
              <ellipse class="eye-p" cx="41" cy="37" rx="1.8" ry="2.2" />
              <ellipse class="eye-o" cx="58" cy="39" rx="4.3" ry="4.9" />
              <ellipse class="eye-p" cx="58" cy="39" rx="1.8" ry="2.2" />
            </template>
          </g>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.lulu {
  position: absolute;
  left: 0;
  bottom: calc(100% - 3px);
  z-index: 2;
  width: 58px;
  height: 43px;
  pointer-events: none;
  transition: transform 0.42s cubic-bezier(0.33, 1, 0.68, 1);
  --lulu-body: #161616;
  --lulu-eye: #f9f5ed;
}
.lulu-svg {
  display: block;
  overflow: visible;
  pointer-events: auto;
  cursor: pointer;
}
.torso {
  fill: var(--lulu-body);
}
.leg,
.arm {
  stroke: var(--lulu-body);
  stroke-linecap: round;
}
.leg {
  stroke-width: 6.2;
}
.arm {
  stroke-width: 7;
  transform-box: fill-box;
}
.arm-l {
  transform-origin: 100% 0%;
}
.arm-r {
  transform-origin: 0% 50%;
}
.eye {
  fill: none;
  stroke: var(--lulu-eye);
  stroke-width: 5.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.eye-o {
  fill: var(--lulu-eye);
}
.eye-p {
  fill: var(--lulu-body);
}
.lulu-body {
  transform-origin: 50% 100%;
  animation: lulu-breathe 3.2s ease-in-out infinite;
}
.walking .lulu-body {
  animation: lulu-hop 0.36s ease-in-out infinite;
}
.walking .leg.la {
  animation: lulu-step 0.36s ease-in-out infinite;
}
.walking .leg.lb {
  animation: lulu-step 0.36s ease-in-out infinite reverse;
}
.s-thinking .lulu-body {
  animation-duration: 0.6s;
}
.s-thinking .leg {
  animation-duration: 0.6s !important;
}
.s-thinking.walking {
  animation: lulu-pace 3.6s ease-in-out infinite;
}
.s-happy .lulu-jump {
  animation: lulu-jump 0.7s cubic-bezier(0.33, 1, 0.68, 1) 1;
}
.s-happy .arm-l {
  animation: lulu-arm-up-l 0.7s ease-in-out 1;
}
.s-happy .arm-r,
.waving .arm-r {
  animation: lulu-wave 0.6s ease-in-out 2;
}
.still .lulu-body,
.still .lulu-jump,
.still .leg,
.still .arm {
  animation: none !important;
}
.still {
  transition: none;
}
@keyframes lulu-breathe {
  0%,
  100% {
    transform: translateY(0) scaleY(1);
  }
  50% {
    transform: translateY(-0.6px) scaleY(1.02);
  }
}
@keyframes lulu-hop {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-1.6px);
  }
}
@keyframes lulu-step {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}
@keyframes lulu-jump {
  0% {
    transform: translateY(0);
  }
  40% {
    transform: translateY(-12px);
  }
  100% {
    transform: translateY(0);
  }
}
@keyframes lulu-wave {
  0%,
  100% {
    transform: rotate(0deg);
  }
  50% {
    transform: rotate(-38deg);
  }
}
@keyframes lulu-arm-up-l {
  0%,
  100% {
    transform: rotate(0deg);
  }
  45% {
    transform: rotate(32deg);
  }
}
@keyframes lulu-pace {
  0%,
  100% {
    translate: 0 0;
  }
  50% {
    translate: 18px 0;
  }
}
</style>

<!-- 深色主题换成暖白身体 + 炭黑眼睛（不加 scoped，选择器挂在根元素上） -->
<style>
:root[data-theme='dark'] .lulu {
  --lulu-body: #f9f5ed;
  --lulu-eye: #161616;
}
</style>
