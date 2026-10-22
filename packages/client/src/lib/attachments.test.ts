import { describe, expect, it } from 'vitest'
import { stripAttachmentNote, withAttachmentNote } from './attachments'

describe('stripAttachmentNote', () => {
  it('说明里的文件都是已显示的图片时去掉说明（中英文）；有非图片文件或不在末尾时保留', () => {
    const imgs = ['uploads/a.png', 'uploads/b.png']
    expect(stripAttachmentNote(withAttachmentNote('看看这张图', imgs), imgs)).toBe('看看这张图')
    expect(stripAttachmentNote('see\n\n(Attachments uploaded to the session workspace: uploads/a.png)', imgs)).toBe(
      'see',
    )
    const mixed = withAttachmentNote('看看', ['uploads/a.png', 'uploads/询价.csv'])
    expect(stripAttachmentNote(mixed, imgs)).toBe(mixed)
    const inline = '正文里提到（附件已上传到会话工作区：uploads/a.png）但不在末尾\n还有'
    expect(stripAttachmentNote(inline, imgs)).toBe(inline)
  })
})
