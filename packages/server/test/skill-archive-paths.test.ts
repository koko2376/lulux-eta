import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：skill 安装解包与同步时的路径穿越与符号链接。
 * - 包内路径里 Windows 会悄悄改写的写法（末尾的点和空格、只有点的目录名、设备名）一律拒绝；
 * - 其他系统打包出来的符号链接条目也能识别并拒绝；
 * - 复制 / 同步 skill 时不跟随、不复制符号链接，目标目录本身是符号链接时不写入。
 */
let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(async () => server?.close())

const md = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: ${name} 的说明，用于测试\n---\n\n# ${name}\n`)

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
  return 'NO_ERROR'
}

describe('包内路径校验', () => {
  it.each([
    'scripts/.. /x.txt',
    'scripts/../x.txt',
    '.../x.txt',
    'a/. /x.txt',
    'SKILL.md.',
    'SKILL.md ',
    'notes /x.txt',
    'CON',
    'scripts/nul.txt',
    'Com1.md',
    'lpt9',
    'a\\..\\..\\x.txt',
    'C:x.txt',
    '\\\\server\\share\\x',
  ])('拒绝 %j', async (path) => {
    const { normalizeEntryPath } = await import('../src/services/skills/package.js')
    expect(code(() => normalizeEntryPath(path))).toBe('SKILL_PATH_INVALID')
  })

  it.each(['scripts/run.cjs', 'references/a.b.txt', 'console.md', 'nul-check/readme.md', '.hidden/x'])('允许 %j', async (path) => {
    const { normalizeEntryPath } = await import('../src/services/skills/package.js')
    expect(normalizeEntryPath(path)).toBe(path)
  })

  it('末尾带点的同名文件不能借 Windows 的改写覆盖 SKILL.md', async () => {
    const { writeZip } = await import('../src/services/skills/zip.js')
    const { packageFromZip } = await import('../src/services/skills/sources.js')
    const zip = writeZip([
      { path: 'SKILL.md', data: md('dots') },
      { path: 'SKILL.md.', data: Buffer.from('---\nname: dots\ndescription: 被替换\n---\n') },
    ])
    expect(code(() => packageFromZip(zip))).toBe('SKILL_PATH_INVALID')
  })
})

describe('符号链接', () => {
  it('创建系统编号为 19 的符号链接条目也拒绝', async () => {
    const { writeZipWithSymlinkForTests } = await import('../src/services/skills/zip.js')
    const { packageFromZip } = await import('../src/services/skills/sources.js')
    const zip = writeZipWithSymlinkForTests([{ path: 'SKILL.md', data: md('mac-link') }], { path: 'link', target: '/etc/passwd' })
    // 把中央目录里所有条目的“创建系统”改成 19（同样带 Unix 权限位）
    const eocd = zip.length - 22
    let pos = zip.readUInt32LE(eocd + 16)
    for (let i = 0; i < zip.readUInt16LE(eocd + 10); i += 1) {
      zip.writeUInt8(19, pos + 5)
      pos += 46 + zip.readUInt16LE(pos + 28) + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32)
    }
    expect(code(() => packageFromZip(zip))).toBe('SKILL_SYMLINK')
  })

  it('复制 skill 时不复制符号链接', async () => {
    const { writeZip } = await import('../src/services/skills/zip.js')
    const zip = writeZip([{ path: 'SKILL.md', data: md('copy-me') }, { path: 'notes/a.txt', data: Buffer.from('a') }]).toString('base64')
    const res = await server.request('POST', '/api/skills/install/zip', { body: { dataBase64: zip } })
    expect(res.status, res.text).toBeLessThan(300)
    const { skillService } = await import('../src/services/skills/skill-service.js')
    const { skillDir } = await import('../src/services/skills/paths.js')
    const outside = mkdtempSync(join(tmpdir(), 'lulux-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(join(outside, 'secret.txt'), join(skillDir('copy-me'), 'leak.txt'))
    symlinkSync(outside, join(skillDir('copy-me'), 'notes', 'dir-link'))
    const target = join(mkdtempSync(join(tmpdir(), 'lulux-copy-')), 'copy-me')
    skillService.copyTo('copy-me', target)
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'notes', 'a.txt'))).toBe(true)
    expect(() => lstatSync(join(target, 'leak.txt'))).toThrow()
    expect(() => lstatSync(join(target, 'notes', 'dir-link'))).toThrow()
  })

  it('内核的 skills 目录被换成符号链接时，同步不往链接目标里写、也不删东西', async () => {
    const { syncSkillsToKernelHome } = await import('../src/services/skills/cli-sync.js')
    const home = mkdtempSync(join(tmpdir(), 'lulux-kernel-home-'))
    const victim = mkdtempSync(join(tmpdir(), 'lulux-victim-'))
    mkdirSync(join(victim, 'important'))
    writeFileSync(join(victim, 'important', 'keep.txt'), 'keep')
    // 让清单声称 important 是之前同步过的 skill：正常情况下会被当成“已禁用”删除
    writeFileSync(join(victim, '.lulux-managed.json'), JSON.stringify({ skills: { important: 'x' } }))
    symlinkSync(victim, join(home, 'skills'))
    const report = syncSkillsToKernelHome('codex', home)
    expect(report.synced).toEqual([])
    expect(report.removed).toEqual([])
    expect(existsSync(join(victim, 'important', 'keep.txt'))).toBe(true)
    expect(readdirSync(victim).sort()).toEqual(['.lulux-managed.json', 'important'])
  })
})
