/**
 * 设置 modelCapabilities（{"模型名或通配": {能力字段...}} 的 JSON）里改写某个模型的 vision。
 * 保留其他模型与该模型的其他字段；原值不是合法 JSON 对象时从空对象开始。
 */
export function setVisionOverride(raw: string, model: string, vision: boolean): string {
  let parsed: Record<string, Record<string, unknown>> = {}
  try {
    const value = raw.trim() ? (JSON.parse(raw) as unknown) : {}
    if (value && typeof value === 'object' && !Array.isArray(value))
      parsed = value as Record<string, Record<string, unknown>>
  } catch {
    parsed = {}
  }
  const current = parsed[model] && typeof parsed[model] === 'object' ? parsed[model] : {}
  parsed[model] = { ...current, vision }
  return JSON.stringify(parsed)
}
