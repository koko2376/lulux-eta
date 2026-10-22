import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { dispatchStreamEvent, type StreamHandlers } from '../api'
import {
  matchesFilter,
  normalizeInstallUrl,
  originLabel,
  searchSkills,
  sessionFileUrl,
  type Skill,
} from '../api/skills'
import ToolTrace from '../components/ToolTrace.vue'
import { approvalTitle, approvalView } from './approval'
import { fileKind } from './artifacts'
import { uploadPath, withAttachmentNote } from './attachments'
import { parseHeadersText } from './kv'

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: 'trade-documents',
    description: '生成外贸单据：形式发票 PI',
    source: 'builtin',
    enabled: true,
    category: 'trade',
    keywords: ['PI', '形式发票'],
    version: '1.0.0',
    author: 'LULUX ETA',
    license: 'BSL-1.1',
    upstream: null,
    requires: { tools: [], mcp: [], npm: [], python: false },
    hasScripts: true,
    readOnly: true,
    modified: false,
    updateAvailable: false,
    origin: 'builtin',
    installedBy: 'system',
    useCount: 0,
    lastUsedAt: null,
    installedAt: 0,
    updatedAt: 0,
    error: null,
    ...over,
  }
}

describe('技能列表辅助函数', () => {
  it('分类 / 导入 / 已停用 / 有更新 筛选', () => {
    const a = skill()
    const b = skill({ name: 'x', source: 'imported', category: 'office', enabled: false })
    const c = skill({ name: 'y', updateAvailable: true, modified: true })
    expect([a, b, c].filter((s) => matchesFilter(s, 'trade')).map((s) => s.name)).toEqual(['trade-documents', 'y'])
    expect([a, b, c].filter((s) => matchesFilter(s, 'imported')).map((s) => s.name)).toEqual(['x'])
    expect([a, b, c].filter((s) => matchesFilter(s, 'disabled')).map((s) => s.name)).toEqual(['x'])
    expect([a, b, c].filter((s) => matchesFilter(s, 'update')).map((s) => s.name)).toEqual(['y'])
    expect([a, b, c].filter((s) => matchesFilter(s, '')).length).toBe(3)
    expect(matchesFilter(skill({ category: null }), 'other')).toBe(true)
  })

  it('搜索匹配名称、描述与关键词（不区分大小写）', () => {
    const list = [skill(), skill({ name: 'pdf-tools', description: 'PDF 提取', keywords: ['pdf'] })]
    expect(searchSkills(list, '形式发票').map((s) => s.name)).toEqual(['trade-documents'])
    expect(searchSkills(list, 'PDF').map((s) => s.name)).toEqual(['pdf-tools'])
    expect(searchSkills(list, '  ').length).toBe(2)
  })

  it('安装地址：owner/repo 补全为 GitHub，其他原样', () => {
    expect(normalizeInstallUrl(' anthropics/skills ')).toBe('https://github.com/anthropics/skills')
    expect(normalizeInstallUrl('owner/repo/tree/main/skills/pdf')).toBe(
      'https://github.com/owner/repo/tree/main/skills/pdf',
    )
    expect(normalizeInstallUrl('https://example.com/SKILL.md')).toBe('https://example.com/SKILL.md')
  })

  it('来源描述：上游仓库优先，其次安装方式', () => {
    expect(
      originLabel(skill({ upstream: { source: 'github.com/NousResearch/hermes-agent', commit: '1f91fb3abc' } })),
    ).toBe('github.com/NousResearch/hermes-agent @ 1f91fb3')
    expect(originLabel(skill())).toBe('LULUX 安装包')
    expect(originLabel(skill({ source: 'imported', origin: 'zip:my.zip' }))).toBe('上传的 my.zip')
    expect(originLabel(skill({ source: 'agent', origin: 'agent' }))).toBe('Agent 在对话中创建')
    expect(originLabel(skill({ source: 'user', origin: 'folder:/tmp/x' }))).toBe('本机文件夹 /tmp/x')
  })

  it('会话文件下载地址与文件类型标签', () => {
    expect(sessionFileUrl('s 1', 'documents/PI-001.pdf')).toBe(
      '/api/chat/sessions/s%201/files?path=documents%2FPI-001.pdf',
    )
    expect(fileKind('a/b.PDF')).toBe('pdf')
    expect(fileKind('x.docx')).toBe('docx')
    expect(fileKind('x.xlsx')).toBe('xlsx')
    expect(fileKind('x.pptx')).toBe('pptx')
    expect(fileKind('noext')).toBe('file')
  })
})

describe('附件与请求头', () => {
  it('附件路径去掉目录与不安全字符，重名自动编号', () => {
    expect(uploadPath('C:\\Users\\me\\报价 单.xlsx')).toBe('uploads/报价 单.xlsx')
    expect(uploadPath('../../etc/passwd')).toBe('uploads/passwd')
    expect(uploadPath('a?.pdf')).toBe('uploads/a.pdf')
    expect(uploadPath('...')).toBe('uploads/file')
    expect(uploadPath('a.pdf', ['uploads/a.pdf', 'uploads/a-2.pdf'])).toBe('uploads/a-3.pdf')
    expect(withAttachmentNote('分析一下', [])).toBe('分析一下')
    expect(withAttachmentNote('分析一下', ['uploads/a.xlsx'])).toContain('uploads/a.xlsx')
  })

  it('请求头文本：冒号或等号分隔，拒绝保留头与非法名称', () => {
    expect(parseHeadersText('Authorization: Bearer a:b\nX-Team=1\n# 注释')).toEqual({
      headers: { Authorization: 'Bearer a:b', 'X-Team': '1' },
      errors: [],
    })
    expect(parseHeadersText('Content-Type: x').errors[0]).toContain('保留')
    expect(parseHeadersText('bad name: x').errors.length).toBe(1)
  })
})

describe('审批卡片详情', () => {
  it('skill_script：技能、脚本、参数、npm 依赖提示', () => {
    const v = approvalView('skill_script', {
      skill: 'trade-documents',
      skillSource: 'imported',
      script: 'trade_docs.cjs',
      args: ['doc-input.json', '--type', 'PI'],
      interpreter: 'node',
      npmToInstall: ['dayjs'],
      timeoutSeconds: 60,
      cwd: '会话工作区',
    })!
    expect(v.title).toBe('运行技能脚本')
    expect(v.rows.find((r) => r.label === '参数')?.value).toBe('doc-input.json --type PI')
    expect(v.rows.find((r) => r.label === '解释器')?.value).toBe('Node.js')
    expect(v.warnings.join()).toContain('dayjs')
    expect(v.warnings.join()).toContain('第三方')
  })

  it('mcp_add：http 只显示请求头名称；stdio 提示系统确认', () => {
    const http = approvalView('mcp_add', {
      transport: 'http',
      name: 'crm',
      url: 'https://mcp.example.com/mcp',
      headerKeys: ['Authorization'],
      nativeConfirm: false,
    })!
    expect(http.rows.map((r) => r.label)).toEqual(['名称', '传输', '地址', '请求头'])
    expect(http.warnings).toEqual([])
    const stdio = approvalView('mcp_add', {
      transport: 'stdio',
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server-fs'],
      envKeys: ['TOKEN'],
      nativeConfirm: true,
    })!
    expect(stdio.rows.find((r) => r.label === '命令')?.value).toBe('npx -y server-fs')
    expect(stdio.warnings[0]).toContain('系统确认')
  })

  it('skill_install / skill_write / mcp_remove / 参数不合法', () => {
    expect(approvalView('skill_install', { url: 'https://github.com/a/b', overwrite: true })!.warnings[0]).toContain(
      '覆盖',
    )
    const write = approvalView('skill_write', {
      name: 'x',
      changes: ['body'],
      files: ['scripts/a.js'],
      hasScripts: true,
    })!
    expect(write.rows.find((r) => r.label === '修改')?.value).toBe('正文')
    expect(write.warnings[0]).toContain('scripts')
    expect(approvalView('mcp_remove', { id: 'm1', name: 'crm', transport: 'http' })!.rows[0]).toEqual({
      label: '名称',
      value: 'crm',
      code: false,
    })
    const bad = approvalView('mcp_add', { invalid: true, errors: ['url：格式不对'], arguments: { url: 'x' } })!
    expect(bad.errors).toEqual(['url：格式不对'])
    expect(approvalView('tool', { a: 1 })).toBeNull()
    expect(approvalTitle(undefined, 'search_customers')).toBe('search_customers')
  })

  it('ToolTrace：canRemember=false 时隐藏“本会话始终允许”，显示详情', async () => {
    const w = mount(ToolTrace, {
      props: {
        name: 'mcp_add',
        server: 'builtin',
        args: '{}',
        status: 'pending',
        result: '',
        durationMs: 0,
        interactive: true,
        risk: 'write',
        approvalKind: 'mcp_add',
        detail: { transport: 'http', name: 'crm', url: 'https://mcp.example.com/mcp', headerKeys: ['Authorization'] },
        canRemember: false,
      },
    })
    expect(w.text()).toContain('添加 MCP 服务')
    expect(w.get('.approval-detail').text()).toContain('Authorization')
    expect(w.text()).not.toContain('本会话始终允许')
    await w.setProps({ canRemember: true })
    expect(w.text()).toContain('本会话始终允许')
  })
})

describe('SSE：skill_preload 与 binary artifact', () => {
  it('分发到对应回调', () => {
    const onSkillPreload = vi.fn()
    const onArtifact = vi.fn()
    const handlers: StreamHandlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onSkillPreload, onArtifact }
    dispatchStreamEvent('skill_preload', { agentId: 'a', skills: ['trade-documents'] }, handlers)
    expect(onSkillPreload).toHaveBeenCalledWith({ agentId: 'a', skills: ['trade-documents'] })
    const artifact = {
      id: 'art1',
      title: 'PI-001.pdf',
      language: 'pdf',
      filename: 'PI-001.pdf',
      path: 'documents/PI-001.pdf',
      size: 1234,
      binary: true,
      mime: 'application/pdf',
      downloadUrl: '/api/chat/sessions/s/files?path=documents%2FPI-001.pdf',
    }
    dispatchStreamEvent('artifact', { agentId: 'a', artifact }, handlers)
    expect(onArtifact.mock.calls[0][0].artifact.downloadUrl).toContain('PI-001.pdf')
  })
})
