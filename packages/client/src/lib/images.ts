/**
 * 聊天图片输入：粘贴 / 拖放 / 选择的图片在上传前校验与缩放。
 * - 支持 png / jpg / webp / gif，单张 ≤ 10 MB，每条消息 ≤ 8 张（含内置浏览器框选截图）；
 * - 长边超过 2048 px 的静态图用 canvas 缩小后再上传（GIF 保留原图以免丢动画；缩放失败时用原图）。
 * 服务端会再按文件头校验一次；模型不支持看图时，消息里的文件路径作为文字兜底。
 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 8
export const IMAGE_MAX_EDGE = 2048

const EXT_TYPE: Record<string, (typeof IMAGE_TYPES)[number]> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 文件的图片类型（先看 MIME，再看扩展名）；不是支持的图片返回 null */
export function imageType(file: Pick<File, 'name' | 'type'>): (typeof IMAGE_TYPES)[number] | null {
  const type = (file.type || '').toLowerCase()
  if ((IMAGE_TYPES as readonly string[]).includes(type)) return type as (typeof IMAGE_TYPES)[number]
  if (type === 'image/jpg') return 'image/jpeg'
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream') return null
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  return EXT_TYPE[ext] ?? null
}

/** 看起来是图片（含不支持的图片格式，如 bmp/svg/heic）：用于给出“格式不支持”的提示 */
export function looksLikeImage(file: Pick<File, 'name' | 'type'>): boolean {
  return (file.type || '').startsWith('image/') || /\.(bmp|svg|heic|heif|tiff?|avif|ico)$/i.test(file.name)
}

export type ImageReject = { file: File; reason: 'type' | 'size' | 'count' }

/**
 * 把一批文件分成：要上传的图片、其他文件（走普通附件）、被拒绝的图片。
 * existing 是输入框里已有的图片数（含浏览器截图）。
 */
export function sortFiles(
  files: File[],
  existing: number,
): { images: File[]; others: File[]; rejected: ImageReject[] } {
  const images: File[] = []
  const others: File[] = []
  const rejected: ImageReject[] = []
  for (const file of files) {
    const type = imageType(file)
    if (!type) {
      if (looksLikeImage(file)) rejected.push({ file, reason: 'type' })
      else others.push(file)
      continue
    }
    if (file.size > IMAGE_MAX_BYTES) rejected.push({ file, reason: 'size' })
    else if (existing + images.length >= MAX_IMAGES) rejected.push({ file, reason: 'count' })
    else images.push(file)
  }
  return { images, others, rejected }
}

/** 等比缩放到长边不超过 max；不需要缩放时原样返回 */
export function fitWithin(
  width: number,
  height: number,
  max = IMAGE_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const edge = Math.max(width, height)
  if (!width || !height || edge <= max) return { width, height, scaled: false }
  const k = max / edge
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true }
}

/** 剪贴板 / 拖放里的文件（截图粘贴时只有 items，没有 name，补一个） */
export function filesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const out: File[] = []
  if (data.files?.length) {
    for (const file of Array.from(data.files)) out.push(file)
    return out
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}

/** 粘贴的截图常常叫 image.png：换成带时间的名字，避免同名 */
export function pastedName(file: File, now = new Date()): string {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file.name
  const pad = (n: number) => String(n).padStart(2, '0')
  const ext = (imageType(file) ?? 'image/png').split('/')[1]!.replace('jpeg', 'jpg')
  return `pasted-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`
}

/**
 * 长边超过 2048 px 的静态图缩小（canvas，按原格式导出，PNG 保留透明）。GIF、无法解码或浏览器不支持时返回原文件。
 */
export async function downscaleImage(
  file: File,
  max = IMAGE_MAX_EDGE,
): Promise<{ blob: Blob; width: number | null; height: number | null; scaled: boolean }> {
  const type = imageType(file)
  if (!type || type === 'image/gif' || typeof createImageBitmap !== 'function') {
    return { blob: file, width: null, height: null, scaled: false }
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { blob: file, width: null, height: null, scaled: false }
  }
  try {
    const fit = fitWithin(bitmap.width, bitmap.height, max)
    if (!fit.scaled) return { blob: file, width: bitmap.width, height: bitmap.height, scaled: false }
    const canvas = document.createElement('canvas')
    canvas.width = fit.width
    canvas.height = fit.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return { blob: file, width: bitmap.width, height: bitmap.height, scaled: false }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, type === 'image/png' ? undefined : 0.9),
    )
    if (!blob || blob.size > IMAGE_MAX_BYTES)
      return { blob: file, width: bitmap.width, height: bitmap.height, scaled: false }
    return { blob, width: fit.width, height: fit.height, scaled: true }
  } finally {
    bitmap.close?.()
  }
}
