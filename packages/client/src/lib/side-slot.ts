import type { InjectionKey } from 'vue'

/** 全局侧栏中部的挂载点：各页面的二级栏（会话列表 / 筛选 / 设置分类）用 SideSlot 传送进来 */
export const SIDE_SLOT_ID = 'app-side-slot'
/** AppLayout 提供 true；单独挂载页面（单测）时没有侧栏，二级栏就地渲染 */
export const SIDE_SLOT_KEY: InjectionKey<boolean> = Symbol('side-slot')
