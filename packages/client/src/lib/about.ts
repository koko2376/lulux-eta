import { localized, t } from '../i18n'
/**
 * 关于页信息（作者、联系方式、仓库、许可）。仓库地址只在这里配置一处。
 */
export const APP_NAME = 'LULUX ETA'
export const AUTHOR = 'koko'
export const authorLocation = (): string => t('about.k41viyn')
export const AUTHOR_EMAIL = 'kokozenshii0308@gmail.com'
export const REPO_URL = 'https://github.com/koko2376/lulux-eta'
/** 浏览器 / 远程模式没有自动更新，“前往下载页”打开这里 */
export const DOWNLOAD_PAGE = `${REPO_URL}/releases/latest`

/** 许可（仓库根目录 LICENSE：Business Source License 1.1，Licensor koko） */
export const LICENSE_NAME = 'Business Source License 1.1'
export const LICENSE_LICENSOR = AUTHOR
export const LICENSE_CHANGE_DATE = '2030-10-20'
export const LICENSE_CHANGE_LICENSE = 'Apache-2.0'
export const LICENSE_POINTS: readonly string[] = localized(() => [
  t('about.k3slav4'),
  t('about.k1uego65'),
  t('about.k15ea5qg'),
  t('about.kjay5ka'),
  t('about.koj67yh', [LICENSE_CHANGE_DATE, LICENSE_CHANGE_LICENSE]),
])

export interface ThirdPartyEntry {
  name: string
  version: string
  license: string
  repo: string
  group: string
}

/**
 * 解析 THIRD_PARTY_LICENSES.md 的表格：生产依赖（Package | Version | License | Used by | Repository）、
 * 随安装包分发的运行时（Component | License | Notes）、Hermes 导入技能（Skill | Author | Upstream path，MIT）。
 * 只取纯文本，界面按文本渲染。
 */
export function parseThirdParty(md: string): ThirdPartyEntry[] {
  const out: ThirdPartyEntry[] = []
  let section = ''
  let header: string[] = []
  const clean = (cell: string) => cell.replace(/`/g, '').replace(/\*\*/g, '').trim()
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim()
      header = []
      continue
    }
    if (!line.startsWith('|')) {
      header = []
      continue
    }
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map(clean)
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue
    if (!header.length) {
      header = cells.map((c) => c.toLowerCase())
      continue
    }
    const col = (name: string) => {
      const i = header.findIndex((h) => h.startsWith(name))
      return i >= 0 ? (cells[i] ?? '') : ''
    }
    if (/^summary/i.test(section)) continue
    if (header[0].startsWith('package')) {
      const onDemand = /on demand/i.test(section)
      out.push({
        name: col('package'),
        version: col('version'),
        license: col('license'),
        repo: col('repository'),
        group: onDemand ? t('about.kxk2oww') : t('about.kikqrqn'),
      })
    } else if (header[0].startsWith('component')) {
      out.push({ name: col('component'), version: '', license: col('license'), repo: '', group: t('about.ka2om2g') })
    } else if (/hermes/i.test(section) && header[0].startsWith('skill')) {
      out.push({
        name: col('skill'),
        version: '',
        license: 'MIT',
        repo: 'https://github.com/NousResearch/hermes-agent',
        group: t('about.k1kqoun8'),
      })
    }
  }
  return out.filter((e) => e.name)
}
