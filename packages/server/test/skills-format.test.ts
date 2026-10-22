import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * Skill 系统单元测试：frontmatter 解析、zip、安装包校验（穿越/符号链接/超限）、
 * skill 内路径解析、内置同步不覆盖用户修改、CLI skill 同步、关键词匹配与索引。
 */
let server: TestServer
let builtinDir = ''

function writeSkill(root: string, name: string, body = '正文', extra = ''): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的说明，用于测试\n${extra}---\n\n# ${name}\n${body}\n`)
}

beforeAll(async () => {
  builtinDir = mkdtempSync(join(tmpdir(), 'lulux-builtin-'))
  writeSkill(builtinDir, 'alpha', 'v1', 'metadata:\n  keywords: [报价, CIF]\n  category: trade\n')
  writeSkill(builtinDir, 'beta', 'v1')
  writeFileSync(join(builtinDir, 'MANIFEST.md'), '# test')
  server = await startTestServer({ LULUX_BUILTIN_SKILLS_DIR: builtinDir })
})
afterAll(() => server.close())

describe('frontmatter 与 SKILL.md 解析', () => {
  it('映射/列表/流式/引号/块标量/注释/数字布尔', async () => {
    const { parseYaml } = await import('../src/services/skills/frontmatter.js')
    const doc = parseYaml(
      [
        'name: demo # 注释',
        'description: "带: 冒号 \\u4e2d"',
        'quote: \'it\'\'s\'',
        'list:',
        '  - a',
        '  - b: 1',
        '    c: [x, "y, z"]',
        'flow: {k: v, n: 2}',
        'nested:',
        '  deep:',
        '    on: true',
        '    num: 1.5',
        'block: |',
        '  第一行',
        '    缩进行',
        '',
        '  第三段',
        'folded: >-',
        '  a',
        '  b',
        'empty:',
      ].join('\n'),
    )
    expect(doc).toEqual({
      name: 'demo',
      description: '带: 冒号 中',
      quote: "it's",
      list: ['a', { b: 1, c: ['x', 'y, z'] }],
      flow: { k: 'v', n: 2 },
      nested: { deep: { on: true, num: 1.5 } },
      block: '第一行\n  缩进行\n\n第三段\n',
      folded: 'a b',
      empty: null,
    })
  })

  it('非法写法报错：Tab 缩进、重复键、__proto__、锚点', async () => {
    const { parseYaml } = await import('../src/services/skills/frontmatter.js')
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/Tab/)
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/重复/)
    expect(() => parseYaml('__proto__: 1')).toThrow(/非法键名/)
    expect(() => parseYaml('a: &x 1')).toThrow(/锚点/)
  })

  it('SKILL.md 校验：name 规则、与目录名一致、description 必填与长度；metadata 扩展键与 Hermes 风格', async () => {
    const { parseSkillMarkdown } = await import('../src/services/skills/format.js')
    expect(() => parseSkillMarkdown('# no frontmatter')).toThrow(/---/)
    expect(() => parseSkillMarkdown('---\nname: Bad_Name\ndescription: x\n---\n')).toThrow(/不合法/)
    expect(() => parseSkillMarkdown('---\nname: -bad\ndescription: x\n---\n')).toThrow(/不合法/)
    expect(() => parseSkillMarkdown('---\nname: ok\n---\n')).toThrow(/description/)
    expect(() => parseSkillMarkdown(`---\nname: ok\ndescription: ${'x'.repeat(1025)}\n---\n`)).toThrow(/过长/)
    expect(() => parseSkillMarkdown('---\nname: ok\ndescription: x\n---\n', 'other')).toThrow(/一致/)
    const parsed = parseSkillMarkdown(
      '---\nname: imported\ndescription: "Hermes style"\nversion: 1.2.0\nauthor: Someone\nlicense: MIT\nmetadata:\n  hermes:\n    tags: [Research, Web]\n  keywords: 报价, 询盘\n  source: https://github.com/x/y\n  upstream-commit: abc\n  requires:\n    tools: [fetch_url]\n    npm: [docx@9]\n    python: true\n---\n\n# Body\n',
      'imported',
    )
    expect(parsed.meta).toMatchObject({
      name: 'imported',
      version: '1.2.0',
      author: 'Someone',
      license: 'MIT',
      keywords: ['报价', '询盘', 'Research', 'Web'],
      upstream: { source: 'https://github.com/x/y', commit: 'abc' },
      requires: { tools: ['fetch_url'], mcp: [], npm: ['docx@9'], python: true },
    })
    expect(parsed.body).toBe('# Body\n')
  })

  it('composeSkillMarkdown 生成的内容能被解析回来', async () => {
    const { composeSkillMarkdown, parseSkillMarkdown } = await import('../src/services/skills/format.js')
    const md = composeSkillMarkdown({ name: 'agent-made', description: '描述: 含冒号 # 和井号', body: '步骤', keywords: ['a,b', 'true', '报价'], category: 'trade', requires: { npm: ['exceljs@4'] } })
    const parsed = parseSkillMarkdown(md, 'agent-made')
    expect(parsed.meta.description).toBe('描述: 含冒号 # 和井号')
    expect(parsed.meta.keywords).toEqual(['a,b', 'true', '报价'])
    expect(parsed.meta.requires.npm).toEqual(['exceljs@4'])
    expect(parsed.body.trim()).toBe('步骤')
  })

  it('全部内置 skill 都能通过安装校验', async () => {
    const { readdirSync } = await import('node:fs')
    const { buildPackage, readSkillDirectory } = await import('../src/services/skills/package.js')
    const root = join(__dirname, '..', 'skills')
    const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    expect(names.length).toBeGreaterThanOrEqual(38)
    for (const name of names) {
      const pkg = buildPackage(readSkillDirectory(join(root, name)), { expectedName: name })
      expect(pkg.parsed.meta.description.length).toBeGreaterThan(20)
      if (pkg.parsed.meta.upstream) {
        expect(pkg.parsed.meta.license).toBe('MIT')
        expect(pkg.parsed.meta.raw.metadata).toMatchObject({ 'upstream-commit': expect.stringMatching(/^[0-9a-f]{40}$/) })
      }
    }
  })
})

describe('zip 与安装包校验', () => {
  it('zip 读写往返；去掉唯一顶层目录；检测 scripts/', async () => {
    const { writeZip, readZip } = await import('../src/services/skills/zip.js')
    const { packageFromZip } = await import('../src/services/skills/sources.js')
    const zip = writeZip([
      { path: 'pkg/SKILL.md', data: Buffer.from('---\nname: zipped\ndescription: zip 测试技能\n---\n正文') },
      { path: 'pkg/scripts/run.cjs', data: Buffer.from('console.log(1)') },
      { path: 'pkg/references/big.txt', data: Buffer.alloc(50_000, 97) },
      { path: '__MACOSX/pkg/._SKILL.md', data: Buffer.from('junk') },
    ])
    const entries = readZip(zip, { maxEntries: 10, maxTotalBytes: 1e6, maxFileBytes: 1e6 })
    expect(entries.find((e) => e.path === 'pkg/references/big.txt')!.data.length).toBe(50_000)
    const pkg = packageFromZip(zip)
    expect(pkg.name).toBe('zipped')
    expect(pkg.hasScripts).toBe(true)
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'references/big.txt', 'scripts/run.cjs'])
  })

  it('拒绝：路径穿越、绝对路径、符号链接、缺 SKILL.md、文件过多/过大、大小写重名、加密/损坏 zip', async () => {
    const { writeZip, writeZipWithSymlinkForTests } = await import('../src/services/skills/zip.js')
    const { packageFromZip } = await import('../src/services/skills/sources.js')
    const { buildPackage, SKILL_LIMITS } = await import('../src/services/skills/package.js')
    const md = Buffer.from('---\nname: evil\ndescription: 恶意测试技能\n---\n')
    const code = (fn: () => unknown): string => {
      try {
        fn()
      } catch (error) {
        return (error as { code?: string }).code ?? String(error)
      }
      return 'NO_ERROR'
    }
    expect(code(() => packageFromZip(writeZip([{ path: 'SKILL.md', data: md }, { path: '../escape.txt', data: Buffer.from('x') }])))).toBe('SKILL_PATH_INVALID')
    expect(code(() => packageFromZip(writeZip([{ path: 'SKILL.md', data: md }, { path: 'a/../../escape.txt', data: Buffer.from('x') }])))).toBe('SKILL_PATH_INVALID')
    expect(code(() => packageFromZip(writeZip([{ path: 'SKILL.md', data: md }, { path: '/etc/passwd', data: Buffer.from('x') }])))).toBe('SKILL_PATH_INVALID')
    expect(code(() => packageFromZip(writeZip([{ path: 'SKILL.md', data: md }, { path: 'C:\\Windows\\x', data: Buffer.from('x') }])))).toBe('SKILL_PATH_INVALID')
    expect(code(() => packageFromZip(writeZipWithSymlinkForTests([{ path: 'SKILL.md', data: md }], { path: 'link', target: '/etc/passwd' })))).toBe('SKILL_SYMLINK')
    expect(code(() => packageFromZip(writeZip([{ path: 'README.md', data: md }])))).toBe('SKILL_MD_MISSING')
    expect(code(() => buildPackage([{ path: 'SKILL.md', data: md }, ...Array.from({ length: SKILL_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}.txt`, data: Buffer.from('x') }))]))).toBe('SKILL_TOO_LARGE')
    expect(code(() => buildPackage([{ path: 'SKILL.md', data: md }, { path: 'big.bin', data: Buffer.alloc(SKILL_LIMITS.maxFileBytes + 1) }]))).toBe('SKILL_TOO_LARGE')
    expect(code(() => buildPackage([{ path: 'SKILL.md', data: md }, { path: 'A.txt', data: Buffer.from('1') }, { path: 'a.txt', data: Buffer.from('2') }]))).toBe('SKILL_PATH_INVALID')
    expect(code(() => buildPackage([{ path: 'SKILL.md', data: Buffer.from('---\nname: Bad Name\ndescription: x\n---\n') }]))).toBe('SKILL_MD_INVALID')
    expect(code(() => packageFromZip(Buffer.from('not a zip at all, definitely not')))).toBe('SKILL_ZIP_INVALID')
    const big = Buffer.alloc(SKILL_LIMITS.maxArchiveBytes + 1)
    expect(code(() => packageFromZip(big))).toBe('SKILL_TOO_LARGE')
  })

  it('本地目录导入：遇到符号链接拒绝；.git/node_modules 被忽略', async () => {
    const { buildPackage, readSkillDirectory } = await import('../src/services/skills/package.js')
    const dir = mkdtempSync(join(tmpdir(), 'lulux-skill-dir-'))
    writeSkill(dir, 'local-one')
    mkdirSync(join(dir, 'local-one', '.git'))
    writeFileSync(join(dir, 'local-one', '.git', 'HEAD'), 'ref')
    const ok = buildPackage(readSkillDirectory(join(dir, 'local-one')), { expectedName: 'local-one' })
    expect(ok.files.map((f) => f.path)).toEqual(['SKILL.md'])
    symlinkSync('/etc/hostname', join(dir, 'local-one', 'leak.txt'))
    expect(() => buildPackage(readSkillDirectory(join(dir, 'local-one')))).toThrow(/符号链接/)
  })
})

describe('内置 skill 同步（manifest + hash）', () => {
  it('首次同步复制内置 skill；未修改的副本随安装包更新；用户改过的保留并标记 updateAvailable；可恢复默认', async () => {
    const { skillService } = await import('../src/services/skills/skill-service.js')
    const { skillDir, skillsRoot } = await import('../src/services/skills/paths.js')
    skillService.ensureReady()
    expect(skillService.get('alpha')).toMatchObject({ source: 'builtin', readOnly: true, modified: false, enabled: true })
    expect(existsSync(join(skillsRoot(), '.builtin-manifest.json'))).toBe(true)

    // 安装包更新：alpha v2、beta v2
    writeSkill(builtinDir, 'alpha', 'v2', 'metadata:\n  keywords: [报价, CIF]\n  category: trade\n')
    writeSkill(builtinDir, 'beta', 'v2')
    // 用户手动改了 beta 的本地副本
    writeFileSync(join(skillDir('beta'), 'SKILL.md'), readFileSync(join(skillDir('beta'), 'SKILL.md'), 'utf8') + '\n用户自己的补充\n')
    const report = skillService.syncBuiltins()
    expect(report.updated).toEqual(['alpha'])
    expect(report.keptModified).toEqual(['beta'])
    expect(readFileSync(join(skillDir('alpha'), 'SKILL.md'), 'utf8')).toContain('v2')
    const beta = readFileSync(join(skillDir('beta'), 'SKILL.md'), 'utf8')
    expect(beta).toContain('用户自己的补充')
    expect(beta).toContain('v1')
    expect(skillService.get('beta')).toMatchObject({ modified: true, updateAvailable: true })

    // 再同步一次：仍不覆盖
    expect(skillService.syncBuiltins().keptModified).toEqual(['beta'])

    // 恢复默认
    skillService.resetBuiltin('beta')
    expect(readFileSync(join(skillDir('beta'), 'SKILL.md'), 'utf8')).toContain('v2')
    expect(skillService.get('beta')).toMatchObject({ modified: false, updateAvailable: false })

    // 内置不可删除，只可禁用；目录被删后下次同步恢复
    expect(() => skillService.remove('alpha')).toThrow(/不能删除/)
    expect(skillService.setEnabled('alpha', false).enabled).toBe(false)
    rmSync(skillDir('alpha'), { recursive: true })
    expect(skillService.syncBuiltins().restored).toEqual(['alpha'])
    expect(skillService.get('alpha')!.enabled).toBe(false)

    // 安装包里去掉了 beta（未修改）→ 删除
    rmSync(join(builtinDir, 'beta'), { recursive: true })
    expect(skillService.syncBuiltins().removed).toEqual(['beta'])
    expect(skillService.get('beta')).toBeUndefined()
    skillService.setEnabled('alpha', true)
  })

  it('手动放进 <dataDir>/skills 的目录登记为 user；同名安装冲突与覆盖备份', async () => {
    const { skillService } = await import('../src/services/skills/skill-service.js')
    const { skillsRoot, backupsRoot } = await import('../src/services/skills/paths.js')
    const { buildPackage } = await import('../src/services/skills/package.js')
    writeSkill(skillsRoot(), 'manual-one')
    skillService.reconcile()
    expect(skillService.get('manual-one')).toMatchObject({ source: 'user', origin: 'local' })
    const pkg = buildPackage([{ path: 'SKILL.md', data: Buffer.from('---\nname: manual-one\ndescription: 新版本的说明文字\n---\n新') }])
    expect(() => skillService.install(pkg, { source: 'imported' })).toThrow(/已存在/)
    const result = skillService.install(pkg, { source: 'imported', overwrite: true })
    expect(result.replaced).toBe(true)
    expect(result.backup && existsSync(result.backup)).toBe(true)
    expect(result.backup!.startsWith(backupsRoot())).toBe(true)
    const builtinClash = buildPackage([{ path: 'SKILL.md', data: Buffer.from('---\nname: alpha\ndescription: 冒充内置的技能\n---\n') }])
    expect(() => skillService.install(builtinClash, { source: 'imported', overwrite: true })).toThrow(/内置/)
  })

  it('skill 内文件读取拒绝穿越与指向目录外的符号链接', async () => {
    const { resolveSkillFile, skillDir } = await import('../src/services/skills/paths.js')
    const { skillService } = await import('../src/services/skills/skill-service.js')
    expect(() => resolveSkillFile('manual-one', '../alpha/SKILL.md')).toThrow(/穿越/)
    expect(() => resolveSkillFile('manual-one', '/etc/passwd')).toThrow(/绝对路径/)
    expect(() => resolveSkillFile('../x', 'SKILL.md')).toThrow(/名称不合法/)
    symlinkSync('/etc/hostname', join(skillDir('manual-one'), 'leak.md'))
    expect(() => resolveSkillFile('manual-one', 'leak.md')).toThrow(/符号链接/)
    rmSync(join(skillDir('manual-one'), 'leak.md'))
    expect(skillService.readFile('manual-one', 'SKILL.md').content).toContain('新')
  })
})

describe('运行时：索引与关键词预加载', () => {
  it('关键词：中文子串、ASCII 词边界', async () => {
    const { keywordHit } = await import('../src/services/skills/runtime.js')
    expect(keywordHit('帮我给这个询盘报个 CIF 价', 'CIF')).toBe(true)
    expect(keywordHit('specification', 'CIF')).toBe(false)
    expect(keywordHit('需要报价单', '报价')).toBe(true)
    expect(keywordHit('a', 'a')).toBe(false)
  })

  it('索引只含已启用、该 Agent 允许的 skill；按 Agent 选择；预加载命中关键词的正文', async () => {
    const { skillIndexFor, preloadSkills } = await import('../src/services/skills/runtime.js')
    const { agentSkills } = await import('../src/services/skills/agent-skills.js')
    const { skillService } = await import('../src/services/skills/skill-service.js')
    expect(skillIndexFor('builtin')).toContain('- alpha：')
    skillService.setEnabled('alpha', false)
    expect(skillIndexFor('builtin')).not.toContain('- alpha：')
    skillService.setEnabled('alpha', true)
    agentSkills.set('kernel-claude-code', 'selected', ['manual-one'])
    expect(skillIndexFor('kernel-claude-code')).toContain('manual-one')
    expect(skillIndexFor('kernel-claude-code')).not.toContain('alpha')
    agentSkills.set('kernel-codex', 'none', [])
    expect(skillIndexFor('kernel-codex')).toBe('')
    const pre = preloadSkills('builtin', '报个 CIF 价', 's1')
    expect(pre.names).toEqual(['alpha'])
    expect(pre.text).toContain('v2')
    expect(preloadSkills('kernel-claude-code', '报个 CIF 价').names).toEqual([])
    expect(skillService.usage('alpha').byKind.preload).toBe(1)
    agentSkills.set('kernel-claude-code', 'all', [])
    agentSkills.set('kernel-codex', 'all', [])
  })
})

describe('第三方内核共享 skill（scoped 隔离目录）', () => {
  it('同步到各 CLI 原生识别的位置；不覆盖非 LULUX 写入的同名目录；跳过疑似密钥文件；禁用后移除', async () => {
    const { syncSkillsToKernelHome } = await import('../src/services/skills/cli-sync.js')
    const { skillService } = await import('../src/services/skills/skill-service.js')
    const { skillDir } = await import('../src/services/skills/paths.js')
    writeFileSync(join(skillDir('manual-one'), '.env'), 'OPENAI_API_KEY=sk-should-not-copy')
    const expected: Record<string, string> = {
      'claude-code': 'skills',
      codex: 'skills',
      'gemini-cli': join('.gemini', 'skills'),
      'qwen-code': 'skills',
    }
    for (const [kernel, rel] of Object.entries(expected)) {
      const home = mkdtempSync(join(tmpdir(), `lulux-home-${kernel}-`))
      mkdirSync(join(home, rel, 'alpha'), { recursive: true })
      writeFileSync(join(home, rel, 'alpha', 'SKILL.md'), 'CLI 用户自己的 alpha')
      const report = syncSkillsToKernelHome(kernel, home)
      expect(report.dir).toBe(join(home, rel))
      expect(report.synced).toContain('manual-one')
      expect(readFileSync(join(home, rel, 'alpha', 'SKILL.md'), 'utf8')).toBe('CLI 用户自己的 alpha')
      expect(existsSync(join(home, rel, 'manual-one', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(home, rel, 'manual-one', '.env'))).toBe(false)
      expect(JSON.parse(readFileSync(join(home, rel, '.lulux-managed.json'), 'utf8')).skills).toHaveProperty('manual-one')
      skillService.setEnabled('manual-one', false)
      expect(syncSkillsToKernelHome(kernel, home).removed).toEqual(['manual-one'])
      expect(existsSync(join(home, rel, 'manual-one'))).toBe(false)
      skillService.setEnabled('manual-one', true)
    }
    expect(syncSkillsToKernelHome('unknown', '/tmp').unsupported).toBe(true)
    rmSync(join(skillDir('manual-one'), '.env'))
  })
})
