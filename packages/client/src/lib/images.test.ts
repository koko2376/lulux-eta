import { describe, expect, it } from 'vitest'
import { filesFromTransfer, fitWithin, imageType, IMAGE_MAX_BYTES, MAX_IMAGES, pastedName, sortFiles } from './images'
import { setVisionOverride } from './vision-settings'

const file = (name: string, type: string, size = 10): File => {
  const f = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('图片输入：校验与缩放', () => {
  it('按 MIME / 扩展名识别 png jpg webp gif；其他图片格式拒绝，非图片走普通附件', () => {
    expect(imageType(file('a.png', 'image/png'))).toBe('image/png')
    expect(imageType(file('a.JPG', ''))).toBe('image/jpeg')
    expect(imageType(file('a', 'image/jpg'))).toBe('image/jpeg')
    expect(imageType(file('a.webp', 'application/octet-stream'))).toBe('image/webp')
    expect(imageType(file('a.bmp', 'image/bmp'))).toBeNull()
    expect(imageType(file('a.pdf', 'application/pdf'))).toBeNull()
    const sorted = sortFiles(
      [
        file('a.png', 'image/png'),
        file('b.bmp', 'image/bmp'),
        file('c.pdf', 'application/pdf'),
        file('big.jpg', 'image/jpeg', IMAGE_MAX_BYTES + 1),
      ],
      0,
    )
    expect(sorted.images.map((f) => f.name)).toEqual(['a.png'])
    expect(sorted.others.map((f) => f.name)).toEqual(['c.pdf'])
    expect(sorted.rejected.map((r) => [r.file.name, r.reason])).toEqual([
      ['b.bmp', 'type'],
      ['big.jpg', 'size'],
    ])
  })

  it('每条最多 8 张（已有的浏览器截图也算）', () => {
    const many = Array.from({ length: 6 }, (_, i) => file(`${i}.png`, 'image/png'))
    const sorted = sortFiles(many, 3)
    expect(sorted.images).toHaveLength(MAX_IMAGES - 3)
    expect(sorted.rejected.every((r) => r.reason === 'count')).toBe(true)
    expect(sorted.rejected).toHaveLength(1)
  })

  it('长边压到 2048 以内，等比；小图不动', () => {
    expect(fitWithin(4096, 2048)).toEqual({ width: 2048, height: 1024, scaled: true })
    expect(fitWithin(1000, 3000)).toEqual({ width: 683, height: 2048, scaled: true })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false })
  })

  it('粘贴的截图改名，避免都叫 image.png；剪贴板 items 里取文件', () => {
    const now = new Date(2026, 9, 21, 9, 5, 7)
    expect(pastedName(file('image.png', 'image/png'), now)).toBe('pasted-20261021-090507.png')
    expect(pastedName(file('blob', 'image/jpeg'), now)).toBe('pasted-20261021-090507.jpg')
    expect(pastedName(file('报价.png', 'image/png'), now)).toBe('报价.png')
    const f = file('x.png', 'image/png')
    const transfer = {
      files: [] as unknown as FileList,
      items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => f }],
    } as unknown as DataTransfer
    expect(filesFromTransfer(transfer)).toEqual([f])
    expect(filesFromTransfer(null)).toEqual([])
  })

  it('模型设置里的看图开关只改该模型的 vision，保留其他覆盖', () => {
    expect(JSON.parse(setVisionOverride('', 'qwen-max', true))).toEqual({ 'qwen-max': { vision: true } })
    const raw = JSON.stringify({ 'qwen-max': { contextWindow: 32768 }, 'my-*': { tools: false } })
    expect(JSON.parse(setVisionOverride(raw, 'qwen-max', false))).toEqual({
      'qwen-max': { contextWindow: 32768, vision: false },
      'my-*': { tools: false },
    })
  })
})
