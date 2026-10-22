'use strict'
// 从 NSIS “卸载程序生成器” exe 中直接解出 uninstaller.exe（等价于在 Windows / wine 上运行它一次）。
// 思路与 electron-builder 的 UninstallerReader 相同（macOS 上它就这么做），区别是：
// 不限定 PE 节名（Debian/mingw 构建的 NSIS 3.1x stub 带 .idata 等节），exehead 结尾取所有含数据节的最大偏移。
// 用法：node nsis-uninstaller.cjs <generator.exe> <uninstaller-out.exe>
const fs = require('node:fs')
const zlib = require('node:zlib')

const NSIS_SIGNATURE = Buffer.from([0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74])

function exeheadEnd(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("Invalid 'MZ' signature")
  const pe = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error("Invalid 'PE' signature")
  const sections = buf.readUInt16LE(pe + 6)
  const optionalSize = buf.readUInt16LE(pe + 20)
  let offset = pe + 24 + optionalSize
  let end = 0
  for (let i = 0; i < sections; i += 1, offset += 40) {
    const rawSize = buf.readUInt32LE(offset + 16)
    const rawPointer = buf.readUInt32LE(offset + 20)
    if (rawSize && rawPointer) end = Math.max(end, rawPointer + rawSize)
  }
  if (!end) throw new Error('No PE sections with data')
  return end
}

function extract(generator) {
  const buf = fs.readFileSync(generator)
  const start = exeheadEnd(buf)
  const data = buf.subarray(start)
  // firstheader：flags(4) + siginfo/“NullsoftInst”(16) + length_of_header(4) + length_of_all_following_data(4)
  if (!data.subarray(4, 20).equals(NSIS_SIGNATURE)) throw new Error('NSIS firstheader not found after exehead')
  if (data.readUInt32LE(24) !== data.length) throw new Error('NSIS data size mismatch')
  let pos = 28
  let inner = null
  while (pos + 4 <= data.length) {
    let size = data.readUInt32LE(pos)
    pos += 4
    const compressed = (size & 0x80000000) !== 0
    size &= 0x7fffffff
    if (size === 0 || pos + size > data.length) break
    let block = data.subarray(pos, pos + size)
    pos += size
    if (compressed) block = zlib.inflateRawSync(block)
    if (block.length >= 20 && block.subarray(4, 20).equals(NSIS_SIGNATURE)) {
      if (inner) throw new Error('Multiple embedded uninstaller blocks')
      inner = block
    }
  }
  if (!inner) throw new Error('Embedded uninstaller block not found')
  return Buffer.concat([buf.subarray(0, start), inner])
}

if (require.main === module) {
  const [generator, out] = process.argv.slice(2)
  if (!generator || !out) {
    console.error('usage: node nsis-uninstaller.cjs <generator.exe> <uninstaller-out.exe>')
    process.exit(2)
  }
  try {
    const result = extract(generator)
    fs.writeFileSync(out, result)
    console.log(`[nsis-uninstaller] ${out} (${result.length} bytes)`)
  } catch (error) {
    console.error(`[nsis-uninstaller] ${error.message}`)
    process.exit(1)
  }
}

module.exports = { extract }
