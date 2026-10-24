import { build } from 'esbuild'
import { cp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')
const root = join(desktop, '..', '..')
const outdir = join(desktop, 'resources', 'server')

/**
 * 需要随包带 node_modules 的依赖：pdfkit 运行时按 package.json "imports" 加载内置字体、按文件路径读取 ICC，
 * 打进单文件会找不到资源，所以保持 external，并把它和依赖树原样复制到 resources/server/node_modules。
 */
const EXTERNAL = ['pdfkit']

// 把服务端连同 koa/undici/imapflow/nodemailer/mailparser 打成一个 CJS 文件
await rm(outdir, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'packages', 'server', 'src', 'index.ts')],
  outfile: join(outdir, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
  external: EXTERNAL,
})

async function packageDir(name, fromDir) {
  const require = createRequire(join(fromDir, 'package.json'))
  // 有 exports 限制的包不能 resolve('x/package.json')：从入口文件向上找
  let dir = dirname(require.resolve(name))
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === name) return dir
    } catch {
      // 继续向上
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`找不到依赖 ${name}`)
    dir = parent
  }
}

const copied = new Set()
async function copyTree(name, fromDir) {
  if (copied.has(name)) return
  copied.add(name)
  const dir = await packageDir(name, fromDir)
  await cp(dir, join(outdir, 'node_modules', name), {
    recursive: true,
    filter: (src) => !/[\\/](test|tests|docs|examples|\.github)[\\/]?$/.test(src) && !src.endsWith('.map'),
  })
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copyTree(dep, dir)
}

for (const name of EXTERNAL) await copyTree(name, join(root, 'packages', 'server'))
console.log(`[bundle-server] copied runtime deps: ${[...copied].join(', ')}`)
