import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * 最小 ZIP 读写（不引入依赖）：只支持 stored(0) / deflate(8)，不支持加密、分卷、ZIP64。
 * 读取以中央目录为准；符号链接条目（Unix 模式 S_IFLNK）原样标记出来，由调用方拒绝。
 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  data: Buffer
}

export interface ZipReadLimits {
  maxEntries: number
  maxTotalBytes: number
  maxFileBytes: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

let crcTable: Uint32Array | null = null
export function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function readZip(buffer: Buffer, limits: ZipReadLimits): ZipEntry[] {
  if (buffer.length < 22) throw new ZipError('不是有效的 zip 文件')
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('不是有效的 zip 文件（找不到目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  const cenSize = buffer.readUInt32LE(eocd + 12)
  const cenOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || cenOffset === 0xffffffff) throw new ZipError('不支持 ZIP64')
  if (count > limits.maxEntries) throw new ZipError(`压缩包内文件过多（${count} > ${limits.maxEntries}）`)
  if (cenOffset + cenSize > buffer.length) throw new ZipError('zip 目录损坏')

  const entries: ZipEntry[] = []
  let total = 0
  let pos = cenOffset
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pos) !== CEN_SIG) throw new ZipError('zip 目录损坏')
    const madeBy = buffer.readUInt16LE(pos + 4)
    const flags = buffer.readUInt16LE(pos + 8)
    const method = buffer.readUInt16LE(pos + 10)
    const expectedCrc = buffer.readUInt32LE(pos + 16)
    const compSize = buffer.readUInt32LE(pos + 20)
    const size = buffer.readUInt32LE(pos + 24)
    const nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30)
    const commentLen = buffer.readUInt16LE(pos + 32)
    const externalAttr = buffer.readUInt32LE(pos + 38)
    const localOffset = buffer.readUInt32LE(pos + 42)
    const rawName = buffer.subarray(pos + 46, pos + 46 + nameLen)
    const path = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen

    if (flags & 0x1) throw new ZipError('不支持加密的 zip')
    const hostOs = madeBy >> 8
    const unixMode = (externalAttr >>> 16) & 0xffff
    // ZIP 规范里带 Unix 权限位的两种创建系统（编号 3 与 19），都可能写出符号链接条目
    const unixLike = hostOs === 3 || hostOs === 19
    const isSymlink = unixLike && (unixMode & 0o170000) === 0o120000
    const isDirectory = path.endsWith('/') || (unixLike && (unixMode & 0o170000) === 0o040000)
    if (size > limits.maxFileBytes) throw new ZipError(`文件过大：${path}（${size} 字节）`)
    total += size
    if (total > limits.maxTotalBytes) throw new ZipError(`解压后总大小超过上限（${limits.maxTotalBytes} 字节）`)

    let data = Buffer.alloc(0)
    if (!isDirectory) {
      if (buffer.readUInt32LE(localOffset) !== LOC_SIG) throw new ZipError(`zip 条目损坏：${path}`)
      const locName = buffer.readUInt16LE(localOffset + 26)
      const locExtra = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + locName + locExtra
      const compressed = buffer.subarray(start, start + compSize)
      if (compressed.length !== compSize) throw new ZipError(`zip 条目截断：${path}`)
      if (method === 0) data = Buffer.from(compressed)
      else if (method === 8) {
        try {
          data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, limits.maxFileBytes) })
        } catch {
          throw new ZipError(`解压失败：${path}`)
        }
      } else throw new ZipError(`不支持的压缩方式 ${method}：${path}`)
      if (data.length !== size) throw new ZipError(`zip 条目大小不符：${path}`)
      if (crc32(data) !== expectedCrc) throw new ZipError(`zip 条目校验失败：${path}`)
    }
    entries.push({ path, isDirectory, isSymlink, size, data })
  }
  return entries
}

export interface ZipInput {
  path: string
  data: Buffer
  mtime?: Date
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

export function writeZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(file.data)
    const deflated = deflateRawSync(file.data)
    const useDeflate = deflated.length < file.data.length
    const body = useDeflate ? deflated : file.data
    const { time, date } = dosTime(file.mtime ?? new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CEN_SIG, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((0o100644 & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cen = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cen.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cen, end])
}

/** 测试用：写一个包含符号链接条目的 zip */
export function writeZipWithSymlinkForTests(files: ZipInput[], symlink: { path: string; target: string }): Buffer {
  const base = writeZip([...files, { path: symlink.path, data: Buffer.from(symlink.target) }])
  // 把最后一个中央目录条目的外部属性改成 S_IFLNK
  const eocd = base.length - 22
  const cenOffset = base.readUInt32LE(eocd + 16)
  let pos = cenOffset
  const count = base.readUInt16LE(eocd + 10)
  for (let i = 0; i < count; i += 1) {
    const nameLen = base.readUInt16LE(pos + 28)
    if (i === count - 1) base.writeUInt32LE(((0o120777 & 0xffff) << 16) >>> 0, pos + 38)
    pos += 46 + nameLen
  }
  return base
}
