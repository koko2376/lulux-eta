/**
 * 邮件图片的类型 / 魔数校验。清洗器、CID 内联图与远程图片代理共用：
 * 只接受 PNG / JPEG / GIF / WebP，声明 MIME 必须与文件魔数一致；
 * SVG、HTML 伪装成图片、MIME 与内容不符的一律拒绝。
 */

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp'

export const IMAGE_MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 去掉参数并统一 image/jpg → image/jpeg */
export function normalizeImageMime(value: string): string {
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return mime === 'image/jpg' ? 'image/jpeg' : mime
}

export function sniffImage(buffer: Buffer): ImageKind | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 6) {
    const head = buffer.toString('ascii', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** 声明 MIME 必须与魔数一致；content-type 缺失时也拒绝（不猜） */
export function kindMatchesMime(kind: ImageKind, mime: string): boolean {
  return IMAGE_MIME[kind] === normalizeImageMime(mime)
}

/** 校验二进制图片；通过时返回规范化 MIME 与 data URL，否则返回 null */
export function imageDataUrl(
  buffer: Buffer,
  declaredMime: string,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): { dataUrl: string; mime: string; kind: ImageKind } | null {
  if (!buffer.length || buffer.length > maxBytes) return null
  const kind = sniffImage(buffer)
  if (!kind || !kindMatchesMime(kind, declaredMime)) return null
  const mime = IMAGE_MIME[kind]
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, mime, kind }
}

/**
 * 校验 HTML 里内联的 `data:image/...;base64,...`。
 * 只接受 base64 载荷，先按长度估算避免解码超大内容，再按魔数确认类型与声明一致。
 * 返回原值（已 trim）或 null。
 */
export function validateDataImageUrl(value: string, maxBytes = DEFAULT_MAX_IMAGE_BYTES): string | null {
  const trimmed = value.trim()
  const match = /^data:(image\/(?:png|jpe?g|gif|webp))((?:;[^,]*)?),([\s\S]*)$/i.exec(trimmed)
  if (!match) return null
  const declared = normalizeImageMime(match[1]!)
  if (!/(?:^|;)base64(?:;|$)/i.test(match[2] ?? '')) return null
  const payload = (match[3] ?? '').replace(/\s+/g, '')
  if (!payload) return null
  // 约等于解码后的字节数；先粗判，避免为超大 base64 分配内存
  if (Math.floor((payload.length * 3) / 4) > maxBytes + 2) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length > maxBytes) return null
  const kind = sniffImage(buffer)
  if (!kind || !kindMatchesMime(kind, declared)) return null
  return trimmed
}
