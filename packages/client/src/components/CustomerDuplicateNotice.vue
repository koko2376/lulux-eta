<script setup lang="ts">
import type { CustomerDuplicate, DuplicateReason } from '../api'
import { t } from '../i18n'

/**
 * 新建客户查重命中提示：只展示已有客户的公司名与负责人（看不见的私有客户不给链接），
 * 用户可以返回修改，或确认“仍然创建”。
 */
defineProps<{ duplicates: CustomerDuplicate[]; busy?: boolean }>()
const emit = defineEmits<{ force: []; back: [] }>()

function reasonLabel(reason: DuplicateReason): string {
  return t(`customerDuplicate.reason_${reason}`)
}
</script>

<template>
  <div class="dup" role="alert" data-test="customer-duplicate">
    <p class="dup-title">{{ $t('customerDuplicate.title') }}</p>
    <ul class="dup-list">
      <li v-for="(d, i) in duplicates" :key="d.id ?? i" class="dup-item">
        <span class="dup-company">
          <RouterLink v-if="d.id" :to="`/customers/${d.id}`" target="_blank">{{ d.company }}</RouterLink>
          <template v-else>{{ d.company }}</template>
        </span>
        <span class="dup-meta">{{ $t('customerDuplicate.owner', [d.ownerName]) }}</span>
        <span class="dup-meta">{{ $t('customerDuplicate.matched', [d.matchedBy.map(reasonLabel).join(' / ')]) }}</span>
      </li>
    </ul>
    <p class="dup-hint">{{ $t('customerDuplicate.hint') }}</p>
    <div class="dup-acts">
      <button type="button" class="kbtn sm" @click="emit('back')">{{ $t('customerDuplicate.back') }}</button>
      <button type="button" class="kbtn sm primary" :disabled="busy" data-test="force-create" @click="emit('force')">
        {{ $t('customerDuplicate.force') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.dup {
  border: 1px solid var(--warn-line);
  background: var(--warn-soft);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.dup-title {
  color: var(--warn-text);
  margin: 0;
  font-weight: 600;
}
.dup-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dup-item {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
}
.dup-company {
  font-weight: 500;
}
.dup-meta,
.dup-hint {
  color: var(--text-secondary);
  font-size: 12px;
}
.dup-hint {
  margin: 0;
}
.dup-acts {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
