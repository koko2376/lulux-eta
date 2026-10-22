import { config } from '@vue/test-utils'
import { i18n } from './i18n'

// 组件测试统一装上 i18n（默认简体中文），模板里的 $t 才可用
config.global.plugins = [...(config.global.plugins ?? []), i18n]
