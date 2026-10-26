/**
 * 工作台「邮件与询盘」折线图（680×186 的 SVG 版式）：把每天的计数换算成坐标。
 * 横轴 44 → 656，纵轴 0 在 y=153，最大刻度在 y=49；刻度取「好看」的整数（0 / 中间 / 最大）。
 */
export interface DayCount {
  date: string
  total: number
  inquiry: number
}

export const CHART = { left: 44, right: 656, zeroY: 153, topY: 49, width: 680, height: 186 }

export function niceMax(n: number): number {
  if (n <= 4) return 4
  const steps = [1, 2, 2.5, 5, 10]
  const mag = 10 ** Math.floor(Math.log10(n))
  for (const s of steps) {
    const v = s * mag
    if (v >= n && (v / 2) % 1 === 0) return v
  }
  return 10 * mag
}

export function chartModel(days: DayCount[]) {
  const max = niceMax(Math.max(0, ...days.map((d) => Math.max(d.total, d.inquiry))))
  const n = days.length
  const x = (i: number) => (n <= 1 ? CHART.right : CHART.left + ((CHART.right - CHART.left) * i) / (n - 1))
  const y = (v: number) => CHART.zeroY - ((CHART.zeroY - CHART.topY) * v) / max
  const pts = (key: 'total' | 'inquiry') => days.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ')
  // 30 天时每 5 天标一个日期，最后一个总是「今天」
  const every = n > 10 ? 5 : 1
  const labels = days
    .map((d, i) => ({ i, x: x(i), text: d.date.slice(5).replace('-', '/') }))
    .filter((l) => (n - 1 - l.i) % every === 0)
  const last = days[n - 1]
  return {
    max,
    ticks: [0, max / 2, max].map((v) => ({ v, y: y(v) })),
    mail: pts('total'),
    inquiry: pts('inquiry'),
    labels,
    end: last
      ? { x: x(n - 1), mailY: y(last.total), inqY: y(last.inquiry), mail: last.total, inquiry: last.inquiry }
      : null,
  }
}
