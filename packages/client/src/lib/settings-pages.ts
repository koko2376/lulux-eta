import { getDesktop } from './desktop'
import { auth } from './session'
import { t } from '../i18n'

export interface SettingsPage {
  key: string
  label: string
  to: string
}
export interface SettingsGroup {
  label: string
  items: SettingsPage[]
}

/** 设置页清单（侧栏与顶栏「搜索设置…」共用）。顺序与分组还原原版：账户与本机打头，业务设置在前；新增的工具 / 连接类单独一组；外观、关于放“其他” */
export function settingsGroups(): SettingsGroup[] {
  return [
    {
      label: '',
      items: [
        {
          key: 'account',
          label: auth.mode === 'server' ? t('settingsSidebar.ko9b1kn') : t('settingsSidebar.ko8g941'),
          to: '/settings/account',
        },
        { key: 'mailbox', label: t('settingsSidebar.k1s375tk'), to: '/settings/mailbox' },
        { key: 'kernels', label: t('settingsSidebar.kuhnvng'), to: '/settings/kernels' },
        { key: 'models', label: t('settingsSidebar.k1fhxwr2'), to: '/settings/models' },
        { key: 'rules', label: t('settingsSidebar.k123t65u'), to: '/settings/rules' },
        { key: 'templates', label: t('settingsSidebar.kvleujt'), to: '/settings/templates' },
        { key: 'backup', label: t('settingsSidebar.k14ecx9c'), to: '/settings/backup' },
        { key: 'trash', label: t('settingsSidebar.trash'), to: '/settings/trash' },
        { key: 'team', label: t('settingsSidebar.kin6nky'), to: '/settings/team' },
      ],
    },
    {
      label: t('setx.groupTools'),
      items: [
        { key: 'builtin', label: t('settingsSidebar.kkn0hhe'), to: '/settings/builtin' },
        { key: 'memory', label: t('settingsSidebar.memory'), to: '/settings/memory' },
        { key: 'mcp', label: t('settingsSidebar.k7cjeqp'), to: '/settings/mcp' },
        { key: 'network', label: t('settingsSidebar.km51t7t'), to: '/settings/network' },
        { key: 'usage', label: t('settingsSidebar.k1ldluuk'), to: '/settings/usage' },
      ],
    },
    {
      label: t('setx.groupOther'),
      items: [
        { key: 'appearance', label: t('settingsSidebar.k2ozcmb'), to: '/settings/appearance' },
        // 托盘 / 开机自启动只在桌面端有
        ...(getDesktop() ? [{ key: 'desktop', label: t('ops.desktopTitle'), to: '/settings/desktop' }] : []),
        { key: 'about', label: t('settingsSidebar.k2i0f5l'), to: '/settings/about' },
      ],
    },
  ]
}
