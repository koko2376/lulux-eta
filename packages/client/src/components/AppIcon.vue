<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string
    size?: number
    strokeWidth?: number
  }>(),
  { size: 18, strokeWidth: 1.7 },
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <g v-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </g>
    <g v-else-if="name === 'pin'">
      <path d="M9 3h6l-1 6 3.5 3.5V14H6.5v-1.5L10 9 9 3z" />
      <path d="M12 14v7" />
    </g>
    <g v-else-if="name === 'users'">
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 19.5c.6-3.4 3.1-5.4 6.2-5.4s5.6 2 6.2 5.4" />
      <path d="M15.2 4.9a3.3 3.3 0 0 1 0 6.3M17.4 14.4c2 .7 3.4 2.4 3.8 5.1" />
    </g>
    <g v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="M16.6 16.6L21 21" />
    </g>
    <g v-else-if="name === 'monitor'">
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M9 21h6M12 17v4" />
    </g>
    <g v-else-if="name === 'chevron-left'">
      <path d="M15 5l-7 7 7 7" />
    </g>
    <g v-else-if="name === 'chevron-down'">
      <path d="M5 9l7 7 7-7" />
    </g>
    <g v-else-if="name === 'upload'">
      <path d="M12 16V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5" />
    </g>
    <g v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09a1.7 1.7 0 001.55-1.11 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H9a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V9a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z"
      />
    </g>
    <g v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6L6 18" />
    </g>
    <g v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </g>
    <g v-else-if="name === 'message'">
      <path
        d="M20.5 11.5a8.5 8.5 0 01-8.5 8.5 8.6 8.6 0 01-3.9-.9L3.5 21l1.9-4.6a8.5 8.5 0 01-1.4-4.9A8.5 8.5 0 0112.5 3a8.5 8.5 0 018 8.5z"
      />
    </g>
    <g v-else-if="name === 'spark'">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    </g>
    <g v-else-if="name === 'arrow-up'">
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </g>
    <g v-else-if="name === 'stop'">
      <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="name === 'plug'">
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3.5a5.5 5.5 0 01-11 0V8z" />
      <path d="M12 17v4" />
    </g>
    <g v-else-if="name === 'trash'">
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7" />
      <path d="M6.5 7l.8 12.1c.1.9.8 1.6 1.8 1.6h5.8c1 0 1.7-.7 1.8-1.6L17.5 7" />
    </g>
    <g v-else-if="name === 'copy'">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </g>
    <g v-else-if="name === 'check'">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </g>
    <g v-else-if="name === 'edit'">
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 00-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </g>
    <g v-else-if="name === 'alert'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16.2v.1" />
    </g>
    <g v-else-if="name === 'refresh'">
      <path d="M20 11a8 8 0 10-2.3 6.1" />
      <path d="M20 5v6h-6" />
    </g>
    <g v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </g>
    <g v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17" />
      <path d="M12 3a14.5 14.5 0 010 18 14.5 14.5 0 010-18z" />
    </g>
    <g v-else-if="name === 'bell'">
      <path d="M18 9a6 6 0 10-12 0c0 5-2 6-2 6h16s-2-1-2-6z" />
      <path d="M10 19a2.2 2.2 0 004 0" />
    </g>
    <g v-else-if="name === 'shield'">
      <path d="M12 3l7 3v5.5c0 4.4-3 7.9-7 9.5-4-1.6-7-5.1-7-9.5V6l7-3z" />
    </g>
    <g v-else-if="name === 'code'">
      <path d="M9 7l-5 5 5 5" />
      <path d="M15 7l5 5-5 5" />
    </g>
    <g v-else-if="name === 'chevron-right'">
      <path d="M9 5l7 7-7 7" />
    </g>
    <g v-else-if="name === 'external'">
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M19 14.5V18a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3.5" />
    </g>
    <g v-else-if="name === 'download'">
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </g>
    <g v-else-if="name === 'paperclip'">
      <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" />
    </g>
    <g v-else-if="name === 'file'">
      <path d="M14 3.5H7.2A2.2 2.2 0 005 5.7v12.6a2.2 2.2 0 002.2 2.2h9.6a2.2 2.2 0 002.2-2.2V8.5z" />
      <path d="M14 3.5v5h5" />
    </g>
    <g v-else-if="name === 'image'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 16l-5-5-8.5 8.5" />
    </g>
    <g v-else-if="name === 'crop'">
      <path
        d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16"
      />
      <path d="M9 12h6M12 9v6" />
    </g>
    <g v-else-if="name === 'cursor'">
      <path d="M5 4l13 6.2-5.6 1.7L10.2 18z" />
      <path d="M12.6 12.1l5 5" />
    </g>
    <g v-else-if="name === 'eye'">
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </g>
    <g v-else-if="name === 'hand'">
      <path d="M8 12.5V6.2a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M10.8 10.6V4.9a1.4 1.4 0 0 1 2.8 0v5.7" />
      <path d="M13.6 10.6V6a1.4 1.4 0 0 1 2.8 0v5.4" />
      <path
        d="M16.4 11.2V8.6a1.4 1.4 0 0 1 2.8 0v5.2c0 4-2.7 7.2-6.7 7.2h-.6c-2.2 0-3.6-.9-4.9-2.6l-2.6-3.6a1.5 1.5 0 0 1 2.3-1.9L8 14.2"
      />
    </g>
    <g v-else-if="name === 'zap'">
      <path d="M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5z" />
    </g>
    <g v-else-if="name === 'sidebar'">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </g>
    <g v-else-if="name === 'skill'">
      <path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />
    </g>
  </svg>
</template>
