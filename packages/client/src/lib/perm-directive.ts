import type { Directive } from 'vue'
import type { Permission } from '../api'
import { denyReason, missingPermission } from './session'

/**
 * v-perm="'data:write'"：没有权限时禁用控件并在 title 里说明原因。
 * v-perm="['data:write', 'customer:delete']"：同时需要多项权限（删除类操作），说明取第一个缺少的权限。
 * v-perm:hide="'data:write'"：没有权限时直接隐藏（用于链接等无法禁用的元素）。
 * 服务端仍会按角色校验（403 FORBIDDEN），这里只负责让界面不误导。
 */
type PermValue = Permission | readonly Permission[]

function apply(el: HTMLElement, value: PermValue, hide: boolean): void {
  const missing = missingPermission(value)
  const allowed = missing === null
  if (hide) {
    el.style.display = allowed ? '' : 'none'
    return
  }
  if (allowed) {
    if (el.dataset.permDenied) {
      delete el.dataset.permDenied
      el.removeAttribute('aria-disabled')
      if (el.title === el.dataset.permTitle) el.removeAttribute('title')
    }
    return
  }
  const reason = denyReason(missing)
  el.dataset.permDenied = '1'
  el.dataset.permTitle = reason
  el.title = reason
  el.setAttribute('aria-disabled', 'true')
  if ('disabled' in el) (el as HTMLButtonElement).disabled = true
}

export const vPerm: Directive<HTMLElement, PermValue> = {
  mounted: (el, binding) => apply(el, binding.value, binding.arg === 'hide'),
  updated: (el, binding) => apply(el, binding.value, binding.arg === 'hide'),
}
