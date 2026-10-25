// 回归测试用：在 LULUX_ETA_HOME 指定的数据目录里以本机（desktop）模式写入各类业务数据
const { runWithContext, LOCAL_ACTOR } = await import('../../src/context.js')
const { customerService } = await import('../../src/services/customer-service.js')
const { taskService } = await import('../../src/services/task-service.js')
const { dealService } = await import('../../src/services/deal-service.js')
const { prospectService } = await import('../../src/services/prospect-service.js')
runWithContext({ actor: LOCAL_ACTOR, ip: '' }, () => {
  const c = customerService.create({ company: 'Legacy Co' })
  taskService.create({ title: 'Legacy task', customerId: c.id })
  dealService.create({ title: 'Legacy deal', customerId: c.id, amount: 1000 })
  prospectService.create({ company: 'Legacy Prospect' })
  console.log('SEEDED', c.id)
})
