import { db } from '../db.js'

let depth = 0

/** 可嵌套的事务：最外层 BEGIN/COMMIT，内层用 SAVEPOINT */
export function transaction<T>(fn: () => T): T {
  const name = `sp_${depth}`
  if (depth === 0) db.exec('BEGIN')
  else db.exec(`SAVEPOINT ${name}`)
  depth += 1
  try {
    const result = fn()
    depth -= 1
    if (depth === 0) db.exec('COMMIT')
    else db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    depth -= 1
    if (depth === 0) db.exec('ROLLBACK')
    else db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
    throw error
  }
}
