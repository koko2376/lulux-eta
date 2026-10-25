import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'
import { uiState } from '../stores/ui'
import BackupSnapshots from './BackupSnapshots.vue'

const location = (extra: Partial<api.BackupLocation> = {}): api.BackupLocation => ({
  dir: '/data/backups',
  defaultDir: '/data/backups',
  custom: false,
  configuredDir: null,
  dataDir: '/data',
  sameDisk: true,
  ...extra,
})
const files: api.BackupFile[] = [
  { name: 'auto-2026.db', size: 2048, createdAt: Date.UTC(2026, 9, 20), kind: 'auto', inCurrentDir: true },
  { name: 'manual-old.db', size: 1024, createdAt: Date.UTC(2026, 9, 1), kind: 'manual', inCurrentDir: false },
]

function signIn(role: api.Role, mode: 'server' | 'desktop' = 'server'): void {
  auth.mode = mode
  auth.me =
    mode === 'server'
      ? ({
          mode: 'server',
          user: { id: 'me', role },
          permissions: role === 'owner' ? [...api.ALL_PERMISSIONS] : role === 'admin' ? api.ALL_PERMISSIONS.filter((p) => p !== 'security:manage') : ['data:read'],
        } as unknown as api.Me)
      : null
}

async function mountWith(loc = location()) {
  vi.spyOn(api.backupApi, 'list').mockResolvedValue({ backups: files, location: loc })
  vi.spyOn(api.restoreApi, 'state').mockResolvedValue({ pending: null, lastResult: null })
  vi.spyOn(api, 'listSettings').mockResolvedValue({ autoBackupHours: '24', autoBackupKeep: '7' })
  const w = mount(BackupSnapshots)
  await flushPromises()
  return w
}

afterEach(() => {
  vi.restoreAllMocks()
  uiState.confirm = null
  auth.mode = 'desktop'
  auth.me = null
  delete (window as { lulux?: unknown }).lulux
})

describe('备份：目录、提醒、下载、删除', () => {
  it('显示目录、同盘提醒、大小与时间；旧目录里的快照有标记', async () => {
    signIn('owner')
    const w = await mountWith()
    expect(w.get('[data-testid="backup-dir"]').text()).toBe('/data/backups')
    expect(w.find('[data-testid="backup-same-disk"]').exists()).toBe(true)
    const rows = w.findAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('2.0 KB')
    expect(rows[1]!.text()).toContain('旧目录')
  })

  it('不同盘时不提醒；设置的目录不可用时提示退回默认目录', async () => {
    signIn('owner')
    const w = await mountWith(location({ sameDisk: false }))
    expect(w.find('[data-testid="backup-same-disk"]').exists()).toBe(false)
    w.unmount()
    const w2 = await mountWith(location({ configuredDir: '/mnt/usb', custom: false }))
    expect(w2.get('[data-testid="backup-dir-unavailable"]').text()).toContain('/mnt/usb')
  })

  it('server：owner 填路径保存；校验失败显示服务端原因', async () => {
    signIn('owner')
    const set = vi
      .spyOn(api.backupApi, 'setLocation')
      .mockRejectedValueOnce(new api.ApiError('VALIDATION_ERROR', '备份目录必须是绝对路径', 400))
      .mockResolvedValueOnce(location({ dir: '/mnt/backup', custom: true, configuredDir: '/mnt/backup', sameDisk: false }))
    const w = await mountWith()
    await w.get('[data-testid="backup-dir-input"]').setValue('relative')
    await w.get('form.dir-form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('备份目录必须是绝对路径')
    await w.get('[data-testid="backup-dir-input"]').setValue('/mnt/backup')
    await w.get('form.dir-form').trigger('submit')
    await flushPromises()
    expect(set).toHaveBeenLastCalledWith('/mnt/backup')
  })

  it('desktop：用原生文件夹选择框', async () => {
    signIn('owner', 'desktop')
    const pickFolder = vi.fn().mockResolvedValue('/Volumes/Backup/lulux')
    ;(window as { lulux?: unknown }).lulux = { platform: 'darwin', pickFolder }
    const set = vi.spyOn(api.backupApi, 'setLocation').mockResolvedValue(location({ dir: '/Volumes/Backup/lulux', custom: true, configuredDir: '/Volumes/Backup/lulux' }))
    const w = await mountWith()
    expect(w.find('[data-testid="backup-dir-input"]').exists()).toBe(false)
    await w.get('[data-testid="backup-dir-pick"]').trigger('click')
    await flushPromises()
    expect(pickFolder).toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('/Volumes/Backup/lulux')
  })

  it('admin 不能改目录，但可以下载和删除（删除需确认）', async () => {
    signIn('admin')
    const blob = new Blob(['x'])
    const dl = vi.spyOn(api.backupApi, 'download').mockResolvedValue(blob)
    const rm = vi.spyOn(api.backupApi, 'remove').mockResolvedValue(undefined)
    const createObjectURL = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const w = await mountWith()
    expect(w.find('[data-testid="backup-dir-input"]').exists()).toBe(false)
    expect(w.text()).toContain('只有 owner 可以修改备份目录')
    await w.findAll('[data-testid="backup-download"]')[0]!.trigger('click')
    await flushPromises()
    expect(dl).toHaveBeenCalledWith('auto-2026.db')
    await w.findAll('[data-testid="backup-delete"]')[0]!.trigger('click')
    await flushPromises()
    expect(uiState.confirm?.danger).toBe(true)
    uiState.confirm?.resolve(true)
    await flushPromises()
    expect(rm).toHaveBeenCalledWith('auto-2026.db')
    expect(w.findAll('tbody tr')).toHaveLength(1)
  })

  it('保存自动备份间隔与保留份数', async () => {
    signIn('owner')
    const upd = vi.spyOn(api, 'updateSettings').mockResolvedValue({ autoBackupHours: '168', autoBackupKeep: '14' })
    const w = await mountWith()
    await w.get('[data-testid="backup-hours"]').setValue('168')
    await w.get('[data-testid="backup-keep"]').setValue('14')
    await w.get('[data-testid="backup-schedule-save"]').trigger('click')
    await flushPromises()
    expect(upd).toHaveBeenCalledWith({ autoBackupHours: '168', autoBackupKeep: '14' })
  })
})
