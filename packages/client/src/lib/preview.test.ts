import { describe, expect, it } from 'vitest'
import { plainPreview, toolPreview } from './preview'

const t = (name: string, approved: boolean, ok = approved) => ({
  id: name,
  name,
  server: 'lulux',
  arguments: '{}',
  ok,
  approved,
  result: '',
  durationMs: 0,
  createdAt: 0,
})

describe('会话列表的工具审批摘要', () => {
  it('只有超时 / 被拒绝的审批时显示审批摘要', () => {
    expect(toolPreview([{ content: '', toolTrace: [t('update_customer', false)] }])).toBe(
      '工具审批未通过：update_customer（已超时或被拒绝）',
    )
  })
  it('多个工具、已执行、失败', () => {
    expect(toolPreview([{ content: '', toolTrace: [t('a', true), t('search_customers', true)] }])).toBe(
      '已调用工具：search_customers 等 2 个',
    )
    expect(toolPreview([{ content: ' ', toolTrace: [t('x', true, false)] }])).toBe('工具调用失败：x')
  })
  it('最后一条有正文或没有工具时为空', () => {
    expect(toolPreview([{ content: '好的', toolTrace: [t('a', false)] }])).toBe('')
    expect(toolPreview([{ content: '', toolTrace: [] }])).toBe('')
    expect(toolPreview([])).toBe('')
  })
})

describe('会话列表预览去掉 Markdown 标记', () => {
  it('标题、粗体、列表、表格、代码', () => {
    expect(
      plainPreview('## 报价要点：DN50 球阀\n\n- **认证**：DVGW\n\n| 事项 | 负责人 |\n| --- | --- |\n| 发报价 | 业务 |'),
    ).toBe('报价要点：DN50 球阀 认证：DVGW 事项 负责人 发报价 业务')
    expect(plainPreview('**汇总** 用 `unit()` 算，见 [文档](https://x.y)\n```ts\nconst a = 1\n```')).toBe(
      '汇总 用 unit() 算，见 文档 const a = 1',
    )
    expect(plainPreview('3 * 4 = 12，snake_case_name 保持原样')).toBe('3 * 4 = 12，snake_case_name 保持原样')
  })
})
