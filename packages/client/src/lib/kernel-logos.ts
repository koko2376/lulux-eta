import gemini from '../assets/gemini.svg'
import qwen from '../assets/qwen.svg'

/**
 * 内核头像（随仓库提供的固定图片，不要换成生成的图）：
 * - 有角色头像 png 的内核：public/agents/{hermes,pi,grok,codex,claude}.png；
 * - 没有 png 的内核：内核管理页的标志 src/assets/{gemini,qwen}.svg（放在白底描边方块里显示）；
 * - LULUX：产品图标 /icon.png。
 * grok.png 给 Grok 内核（xAI Grok Build CLI）。
 */
const AVATARS: Record<string, string> = {
  builtin: '/icon.png',
  hermes: '/agents/hermes.png',
  pi: '/agents/pi.png',
  grok: '/agents/grok.png',
  codex: '/agents/codex.png',
  'claude-code': '/agents/claude.png',
}

const LOGOS: Record<string, string> = {
  'gemini-cli': gemini,
  'qwen-code': qwen,
}

/** 没有 png 头像的内核的 svg 标志（需要放在方块里显示）；其他内核返回 null */
export function kernelLogo(kernelId: string | null | undefined): string | null {
  if (!kernelId) return null
  return LOGOS[kernelId] ?? null
}

/** 内核头像：{ src, tile }，tile=true 表示是 svg 标志、要放在白底方块里；未知内核返回 null */
export function kernelAvatar(kernelId: string | null | undefined): { src: string; tile: boolean } | null {
  if (!kernelId) return null
  if (AVATARS[kernelId]) return { src: AVATARS[kernelId], tile: false }
  if (LOGOS[kernelId]) return { src: LOGOS[kernelId], tile: true }
  return null
}
