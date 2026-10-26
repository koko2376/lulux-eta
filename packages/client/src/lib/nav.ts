/**
 * 主导航（侧栏底部 6 个入口）与页面分组标签。
 * 入口按 route.meta.section 判断是否选中；客户 / 邮箱 / 工作流三个入口下面各有一组顶部标签，
 * 标签按路径前缀判断选中。路径本身没有变化，旧书签 / Agent 给的链接照常能打开。
 */
export type NavIcon = 'agent' | 'workbench' | 'customers' | 'mailbox' | 'workflows' | 'skills'

export interface NavEntry {
  id: NavIcon
  to: string
  /** i18n key */
  label: string
  /** 属于这个入口的 route.meta.section */
  sections: string[]
  testid?: string
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'agent', to: '/agent', label: 'appRail.agent', sections: ['agent'], testid: 'rail-agent' },
  { id: 'workbench', to: '/', label: 'appRail.k10rnjfv', sections: ['workbench'], testid: 'rail-workbench' },
  {
    id: 'customers',
    to: '/customers',
    label: 'appRail.customers',
    sections: ['customers', 'quotation', 'deals', 'orders'],
    testid: 'rail-customers',
  },
  { id: 'mailbox', to: '/mailbox', label: 'appRail.k182knuk', sections: ['mailbox'], testid: 'rail-mailbox' },
  {
    id: 'workflows',
    to: '/workflows',
    label: 'appRail.workflows',
    sections: ['workflows', 'schedules'],
    testid: 'rail-workflows',
  },
  { id: 'skills', to: '/skills', label: 'appRail.skills', sections: ['skills'], testid: 'rail-skills' },
]

export function navEntryFor(section: string): NavEntry | null {
  return NAV_ENTRIES.find((entry) => entry.sections.includes(section)) ?? null
}

export interface SectionTab {
  to: string
  label: string
  /** 这些路径前缀都算这个标签 */
  prefixes: string[]
  testid: string
}

export const SECTION_TABS: Record<string, SectionTab[]> = {
  customers: [
    { to: '/prospects', label: 'appRail.prospects', prefixes: ['/prospects'], testid: 'tab-prospects' },
    { to: '/customers', label: 'appRail.customers', prefixes: ['/customers'], testid: 'tab-customers' },
    { to: '/deals', label: 'appRail.deals', prefixes: ['/deals'], testid: 'tab-deals' },
    { to: '/quotation', label: 'appRail.kxbx0dt', prefixes: ['/quotation', '/products'], testid: 'tab-quotation' },
    { to: '/orders', label: 'appRail.orders', prefixes: ['/orders'], testid: 'tab-orders' },
  ],
  mailbox: [
    { to: '/mailbox', label: 'appRail.inbox', prefixes: ['/mailbox'], testid: 'tab-inbox' },
    { to: '/sequences', label: 'appRail.sequences', prefixes: ['/sequences'], testid: 'tab-sequences' },
  ],
  workflows: [
    { to: '/workflows', label: 'appRail.workflows', prefixes: ['/workflows'], testid: 'tab-workflows' },
    { to: '/schedules', label: 'appRail.schedules', prefixes: ['/schedules'], testid: 'tab-schedules' },
  ],
}

export function tabsFor(section: string): SectionTab[] {
  const entry = navEntryFor(section)
  return entry ? (SECTION_TABS[entry.id] ?? []) : []
}

export function tabActive(tab: SectionTab, path: string): boolean {
  return tab.prefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'))
}
