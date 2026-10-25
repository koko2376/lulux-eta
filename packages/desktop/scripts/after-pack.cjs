// electron-builder afterPack 钩子。
// 在非 Windows 主机上交叉打 Windows 包时，electron-builder 需要 wine 运行 rcedit 才能写入 exe 图标与版本信息；
// 没有 wine（或像 arm64 Linux 这样跑不了 x86 wine）时，构建脚本传 -c.win.signAndEditExecutable=false，
// 由这里用纯 JS 的 resedit 写入图标、版本号、产品名。保留 exe 里已有的其他资源（含 ELECTRONASAR 完整性校验）。
// Windows 主机 / 有签名证书时 electron-builder 自己的 rcedit + 签名照常执行（本钩子跳过）。
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const LANG_EN_US = 1033
const CODEPAGE_UNICODE = 1200

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  if (process.platform === 'win32') return
  if (process.env.LULUX_SKIP_RESEDIT === '1') return

  const ResEdit = require('resedit')
  const { packager, appOutDir } = context
  const appInfo = packager.appInfo
  const exe = join(appOutDir, `${appInfo.productFilename}.exe`)
  const icon = join(packager.info.buildResourcesDir, 'icon.ico')

  const executable = ResEdit.NtExecutable.from(await readFile(exe), { ignoreCert: true })
  const resource = ResEdit.NtExecutableResource.from(executable)

  const iconFile = ResEdit.Data.IconFile.from(await readFile(icon))
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries)
  const iconId = groups.length > 0 ? groups[0].id : 1
  const iconLang = groups.length > 0 ? groups[0].lang : LANG_EN_US
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resource.entries,
    iconId,
    iconLang,
    iconFile.icons.map((item) => item.data),
  )

  const [version] = ResEdit.Resource.VersionInfo.fromEntries(resource.entries)
  const info = version ?? ResEdit.Resource.VersionInfo.createEmpty()
  const langs = info.getAllLanguagesForStringValues()
  const lang = langs[0] ?? { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE }
  const numeric = appInfo.version.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  while (numeric.length < 4) numeric.push(0)
  info.setFileVersion(numeric[0], numeric[1], numeric[2], numeric[3], lang.lang)
  info.setProductVersion(numeric[0], numeric[1], numeric[2], numeric[3], lang.lang)
  info.setStringValues(lang, {
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    CompanyName: appInfo.companyName || appInfo.productName,
    LegalCopyright: appInfo.copyright,
    InternalName: appInfo.productFilename,
    OriginalFilename: `${appInfo.productFilename}.exe`,
    FileVersion: appInfo.version,
    ProductVersion: appInfo.version,
  })
  info.outputToResourceEntries(resource.entries)

  resource.outputResource(executable)
  await writeFile(exe, Buffer.from(executable.generate()))
  console.log(`  • resedit: wrote icon + version info to ${exe}`)
}
