import { join } from 'node:path'
import { config } from '../../config.js'

/** 内核安装根目录：<dataDir>/kernels/（测试可用 LULUX_KERNELS_DIR 改到别处） */
export function kernelsRoot(): string {
  return process.env.LULUX_KERNELS_DIR || join(config.home, 'kernels')
}

export function kernelDir(id: string): string {
  return join(kernelsRoot(), id)
}

/** 会话 id → 目录名（scoped 内核的独立 HOME：<kernelsRoot>/<id>/home/<segment>） */
export function sessionHomeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'default'
}
