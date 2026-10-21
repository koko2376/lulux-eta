<script setup lang="ts">
/**
 * 报价单“成品文档”视图（还原原版 0f0d587 的 QUOTATION 版式）：
 * 抬头取默认报价模板的公司信息 / Logo，客户、条款、明细、合计、交期付款等全部来自真实报价数据。
 */
import { computed } from 'vue'
import type * as api from '../api'
import logoUrl from '../assets/lulux-neutral.png'
import { formatMoney, lineAmount, totalQty } from '../lib/quote'
import { formatDate } from '../lib/labels'

const props = defineProps<{
  quote: api.Quote
  customer: api.Customer | null
  template: api.QuoteTemplate | null
  products: api.Product[]
}>()

const company = computed(() => props.template?.company ?? null)
const contact = computed(() => props.customer?.contacts.find((c) => c.isPrimary) ?? props.customer?.contacts[0] ?? null)
const productOf = (id: string | null) => (id ? (props.products.find((p) => p.id === id) ?? null) : null)
const money = (v: number) => formatMoney(v, props.quote.currency)
const terms = computed(() => [props.quote.incoterm, props.quote.port].filter(Boolean).join(' '))
const validDays = computed(() => {
  const created = new Date(props.quote.createdAt)
  const until = new Date(props.quote.validUntil)
  if (Number.isNaN(created.getTime()) || Number.isNaN(until.getTime())) return null
  return Math.max(0, Math.round((until.getTime() - created.getTime()) / 86400000))
})
</script>

<template>
  <article class="qsheet" data-testid="quote-sheet">
    <header class="qs-top">
      <div class="qs-brand">
        <img :src="company?.logoDataUrl || logoUrl" alt="" />
        <div>
          <b>{{ company?.name || 'LULUX ETA' }}</b>
          <div v-if="company?.address || company?.phone">
            {{ [company?.address, company?.phone].filter(Boolean).join(' · ') }}
          </div>
          <RouterLink v-else to="/settings/templates" class="qs-hint">{{ $t('quox.letterheadHint') }}</RouterLink>
        </div>
      </div>
      <div class="qs-no">
        <div class="n">QUOTATION · {{ quote.number }}</div>
        <div class="d">
          {{ formatDate(quote.createdAt) }}
          <template v-if="validDays !== null"> · {{ $t('quox.validDays', [validDays]) }}</template>
        </div>
      </div>
    </header>

    <div class="qs-parties">
      <div>
        <div class="qp-label">{{ $t('quox.to') }}</div>
        <div class="qp-name">{{ customer?.company || $t('quotation.k1c07rhc') }}</div>
        <div class="qp-line">
          <template v-if="contact"
            >Attn: {{ contact.name }}<template v-if="contact.title">, {{ contact.title }}</template
            ><br
          /></template>
          <template v-if="customer?.country">{{ customer.country }}<br /></template>
          <template v-if="contact?.email">{{ contact.email }}</template>
        </div>
      </div>
      <div>
        <div class="qp-label">{{ $t('quox.terms') }}</div>
        <div class="qp-line strong">
          {{ terms || '—' }} · {{ quote.currency }}<br />
          <template v-if="quote.paymentTerms">{{ quote.paymentTerms }}</template>
        </div>
      </div>
    </div>

    <div class="qitems-wrap" data-hscroll-ok>
      <table class="qitems">
        <thead>
          <tr>
            <th class="c-i">#</th>
            <th>{{ $t('quox.nameSpec') }}</th>
            <th class="r c-q">{{ $t('quotation.k1fiq1pt') }}</th>
            <th class="r c-u">{{ $t('quotation.k13m8dl3') }}</th>
            <th class="r c-p">{{ $t('quotation.k340tg1') }}</th>
            <th class="r c-a">{{ $t('quox.lineTotal') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in quote.items" :key="i">
            <td class="r idx">{{ i + 1 }}</td>
            <td>
              <div class="qitem-name">{{ item.name }}</div>
              <div v-if="item.spec || productOf(item.productId)" class="qitem-desc">
                <template v-if="item.spec">{{ item.spec }}</template>
                <template v-if="productOf(item.productId)?.sku">
                  <template v-if="item.spec"> · </template>{{ productOf(item.productId)?.sku }}</template
                >
                <template v-if="productOf(item.productId)?.hsCode">
                  · HS {{ productOf(item.productId)?.hsCode }}</template
                >
              </div>
            </td>
            <td class="r">{{ item.qty }}</td>
            <td class="r dim">{{ item.unit }}</td>
            <td class="r">{{ money(item.unitPrice) }}</td>
            <td class="r">{{ money(lineAmount(item, quote.currency)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="qsum">
      <table>
        <tbody>
          <tr>
            <td>{{ $t('quox.goodsTotal') }}</td>
            <td class="r">{{ money(quote.subtotal) }}</td>
          </tr>
          <tr>
            <td>{{ $t('quox.qtyTotal') }}</td>
            <td class="r">{{ totalQty(quote.items) }}</td>
          </tr>
          <tr class="total">
            <td>{{ $t('quox.grandTotal', [terms || quote.currency]) }}</td>
            <td class="r">{{ money(quote.subtotal) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="qterms">
      <div>
        <div class="qt-label">{{ $t('quox.leadTime') }}</div>
        <div class="qt-val">{{ quote.leadTime || '—' }}</div>
      </div>
      <div>
        <div class="qt-label">{{ $t('quox.payment') }}</div>
        <div class="qt-val">{{ quote.paymentTerms || '—' }}</div>
      </div>
      <div>
        <div class="qt-label">{{ $t('quox.validity') }}</div>
        <div class="qt-val">{{ quote.validUntil ? $t('quox.validUntil', [quote.validUntil]) : '—' }}</div>
      </div>
      <div>
        <div class="qt-label">{{ $t('quox.incoterm') }}</div>
        <div class="qt-val">{{ terms || '—' }}</div>
      </div>
      <div>
        <div class="qt-label">{{ $t('quox.currency') }}</div>
        <div class="qt-val">{{ quote.currency }}</div>
      </div>
      <div v-if="company?.email || company?.phone">
        <div class="qt-label">{{ $t('quox.contact') }}</div>
        <div class="qt-val">{{ [company?.email, company?.phone].filter(Boolean).join(' · ') }}</div>
      </div>
    </div>

    <div v-if="quote.notes" class="qnote">{{ $t('quox.notePrefix') }}{{ quote.notes }}</div>
  </article>
</template>

<style scoped>
.qsheet {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 28px 24px;
  min-width: 0;
}
.qs-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}
.qs-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.qs-brand img {
  width: 30px;
  height: 30px;
  object-fit: contain;
  flex: none;
}
.qs-brand b {
  font-size: 14px;
  letter-spacing: 0.01em;
}
.qs-brand div div,
.qs-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.qs-hint {
  display: block;
  text-decoration: underline;
}
.qs-no {
  text-align: right;
  flex: none;
}
.qs-no .n {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.qs-no .d {
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 3px;
}
.qs-parties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 20px 0 18px;
}
.qp-label,
.qt-label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
  font-weight: 600;
  margin-bottom: 6px;
  text-transform: uppercase;
}
.qp-name {
  font-size: 13.5px;
  font-weight: 600;
}
.qp-line {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.qp-line.strong {
  color: var(--text);
}
.qitems-wrap {
  position: relative;
  overflow-x: auto;
}
table.qitems {
  width: 100%;
  border-collapse: collapse;
  margin-top: 4px;
}
table.qitems th {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  font-weight: 500;
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
table.qitems td {
  padding: 11px 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--surface-muted);
  vertical-align: top;
}
table.qitems th.r,
table.qitems td.r {
  text-align: right;
}
table.qitems td.r {
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
}
table.qitems td.idx,
table.qitems td.dim {
  color: var(--text-tertiary);
}
.c-i {
  width: 34px;
}
.c-q,
.c-u {
  width: 62px;
}
.c-p {
  width: 104px;
}
.c-a {
  width: 120px;
}
.qitem-name {
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.qitem-desc {
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 2px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.qsum {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
}
.qsum table {
  width: 300px;
  border-collapse: collapse;
}
.qsum td {
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.qsum td.r {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.qsum tr.total td {
  padding-top: 11px;
  border-top: 1px solid var(--line);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.qterms {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px 22px;
}
.qt-label {
  letter-spacing: 0.08em;
  margin-bottom: 0;
}
.qt-val {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-top: 3px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.qnote {
  margin-top: 18px;
  font-size: 11.5px;
  color: var(--text-tertiary);
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
