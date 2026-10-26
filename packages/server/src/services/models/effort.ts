/** 推理强度五档（界面：关闭 / 低 / 中 / 高 / 极高），契约 §6.13。单独成文件，避免 session-service ↔ catalog 循环依赖 */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}
