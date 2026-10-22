#!/usr/bin/env node
// 本地模拟 GitHub Releases 下载源（electron-updater generic provider）：静态目录 + HTTP Range（含多段 multipart/byteranges，
// 供 AppImage / NSIS 差分下载使用）。只监听 127.0.0.1。每个请求打一行日志（方法、路径、Range、状态码、字节数）。
//   node scripts/update-smoke/serve-updates.mjs <目录> [端口=0] [--port-file 文件]
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const root = resolve(args[0] ?? '.')
const port = Number(args[1] && !args[1].startsWith('--') ? args[1] : 0)
const portFileIndex = args.indexOf('--port-file')
const portFile = portFileIndex >= 0 ? args[portFileIndex + 1] : null

function parseRanges(header, size) {
  const match = /^bytes=(.+)$/.exec(header ?? '')
  if (!match) return null
  const ranges = []
  for (const part of match[1].split(',')) {
    const [a, b] = part.trim().split('-')
    let start
    let end
    if (a === '') {
      start = Math.max(0, size - Number(b))
      end = size - 1
    } else {
      start = Number(a)
      end = b === '' || b === undefined ? size - 1 : Math.min(Number(b), size - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
    ranges.push([start, end])
  }
  return ranges.length ? ranges : null
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const name = basename(decodeURIComponent(url.pathname))
  const file = join(root, name)
  let size
  try {
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    res.writeHead(404).end('not found')
    console.log(`${req.method} ${url.pathname} 404`)
    return
  }
  const type = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream'
  const ranges = parseRanges(req.headers.range, size)
  const tag = req.headers.range ? ` range=${req.headers.range.length > 60 ? `${req.headers.range.slice(0, 60)}…(${req.headers.range.split(',').length} parts)` : req.headers.range}` : ''
  if (ranges === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    console.log(`${req.method} ${url.pathname}${tag} 416`)
    return
  }
  if (!ranges) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
    console.log(`${req.method} ${url.pathname} 200 bytes=${size}`)
    return
  }
  if (ranges.length === 1) {
    const [start, end] = ranges[0]
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file, { start, end }).pipe(res)
    console.log(`${req.method} ${url.pathname}${tag} 206 bytes=${end - start + 1}`)
    return
  }
  const boundary = `lulux${Date.now().toString(16)}`
  const heads = ranges.map(([start, end]) => `--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`)
  const tail = `\r\n--${boundary}--\r\n`
  const total = ranges.reduce((sum, [start, end], i) => sum + Buffer.byteLength(heads[i]) + (end - start + 1) + (i > 0 ? 2 : 0), 0) + Buffer.byteLength(tail)
  res.writeHead(206, { 'Content-Type': `multipart/byteranges; boundary=${boundary}`, 'Content-Length': total, 'Accept-Ranges': 'bytes' })
  let bytes = 0
  const writePart = (i) => {
    if (i >= ranges.length) {
      res.end(tail)
      console.log(`${req.method} ${url.pathname}${tag} 206 multipart parts=${ranges.length} bytes=${bytes}`)
      return
    }
    const [start, end] = ranges[i]
    bytes += end - start + 1
    res.write((i > 0 ? '\r\n' : '') + heads[i])
    const stream = createReadStream(file, { start, end })
    stream.on('end', () => writePart(i + 1))
    stream.pipe(res, { end: false })
  }
  writePart(0)
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  if (portFile) writeFileSync(portFile, String(actual))
  console.log(`[serve-updates] http://127.0.0.1:${actual}/ → ${root}`)
})
