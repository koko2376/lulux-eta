/** 导入行的源文件行号：客户端解析表格时给每行带上 __line（表头是第 1 行），报错时优先用它，和文件里的行号对上 */
export const IMPORT_LINE_KEY = '__line'

export function importLineOf(row: Record<string, unknown>, fallback: number): number {
  const line = Number(row[IMPORT_LINE_KEY])
  return Number.isInteger(line) && line > 0 ? line : fallback
}
