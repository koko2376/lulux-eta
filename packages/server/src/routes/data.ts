import type Router from '@koa/router'
import { assertImportPayload, dataService } from '../services/data-service.js'
import { backupService } from '../services/backup-service.js'
import { currentActor } from '../context.js'

export function dataRoutes(router: Router): void {
  router.get('/api/data/summary', (ctx) => {
    ctx.body = dataService.summary()
  })
  router.get('/api/data/export', (ctx) => {
    ctx.body = dataService.export()
  })
  router.post('/api/data/import', (ctx) => {
    assertImportPayload(ctx.request.body)
    ctx.body = dataService.import(ctx.request.body)
  })
  router.get('/api/data/backups', (ctx) => {
    // 服务器上的数据目录 / 备份目录路径只给 owner（desktop 模式下本机用户就是 owner）
    ctx.body = currentActor().role === 'owner' ? { backups: backupService.list(), location: backupService.location() } : { backups: backupService.list() }
  })
  router.put('/api/data/backups/location', (ctx) => {
    ctx.body = backupService.setLocation(ctx.request.body ?? {})
  })
  router.get('/api/data/backups/:name/download', (ctx) => {
    const file = backupService.file(ctx.params.name)
    ctx.set('Content-Disposition', `attachment; filename="${ctx.params.name}"`)
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.type = 'application/octet-stream'
    ctx.length = file.size
    ctx.body = backupService.open(file.path)
  })
  router.delete('/api/data/backups/:name', (ctx) => {
    backupService.remove(ctx.params.name)
    ctx.status = 204
  })
  router.post('/api/data/backups', (ctx) => {
    ctx.status = 201
    ctx.body = backupService.create('manual')
  })
  router.post('/api/data/backups/:name/restore', (ctx) => {
    ctx.body = backupService.requestRestore(ctx.params.name)
  })
  router.get('/api/data/restore', (ctx) => {
    ctx.body = backupService.restoreState()
  })
  router.delete('/api/data/restore', (ctx) => {
    ctx.body = { cancelled: backupService.cancelRestore() }
  })
  router.delete('/api/data/sessions', (ctx) => {
    ctx.body = { removed: dataService.clearSessions() }
  })
}
