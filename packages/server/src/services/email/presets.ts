export interface EmailPreset {
  id: string
  name: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  authTypes: Array<'password' | 'oauth2'>
  oauthProvider: 'google' | 'microsoft' | null
  authHint: string
  helpUrl: string | null
  appendToSent: boolean
  domains: string[]
}

/** 常见服务商预设（契约 4.1） */
export const EMAIL_PRESETS: EmailPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    authTypes: ['oauth2', 'password'],
    oauthProvider: 'google',
    authHint: '推荐用 OAuth 授权。若用密码方式：需开启两步验证并生成“应用专用密码”，密码栏填 16 位应用专用密码。',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    appendToSent: false,
    domains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'outlook',
    name: 'Outlook.com / Hotmail',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    authTypes: ['oauth2'],
    oauthProvider: 'microsoft',
    authHint: '微软个人邮箱已停用基本认证（密码登录），请用 OAuth 授权。',
    helpUrl: 'https://support.microsoft.com/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353',
    appendToSent: false,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
  {
    id: 'office365',
    name: 'Microsoft 365 / Exchange Online',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    authTypes: ['oauth2', 'password'],
    oauthProvider: 'microsoft',
    authHint: '推荐 OAuth 授权；管理员需为邮箱开启 IMAP 与“经身份验证的 SMTP”。',
    helpUrl: 'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4',
    appendToSent: false,
    domains: [],
  },
  {
    id: 'qq',
    name: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '需在 QQ 邮箱“设置 → 账号”里开启 IMAP/SMTP 服务并生成授权码，密码栏填授权码（不是 QQ 密码）。',
    helpUrl: 'https://service.mail.qq.com/detail/0/75',
    appendToSent: true,
    domains: ['qq.com', 'foxmail.com', 'vip.qq.com'],
  },
  {
    id: 'exmail-qq',
    name: '腾讯企业邮',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '需在企业邮“设置 → 客户端设置”开启 IMAP/SMTP；开启“安全登录”后密码栏填客户端专用密码。',
    helpUrl: 'https://open.work.weixin.qq.com/help2/pc/18624',
    appendToSent: true,
    domains: [],
  },
  {
    id: '163',
    name: '网易 163 邮箱',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '需在 163 邮箱“设置 → POP3/SMTP/IMAP”开启 IMAP/SMTP 服务并获取授权码，密码栏填授权码。',
    helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2',
    appendToSent: true,
    domains: ['163.com', 'vip.163.com'],
  },
  {
    id: '126',
    name: '网易 126 邮箱',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '需在 126 邮箱设置里开启 IMAP/SMTP 服务并获取授权码，密码栏填授权码。',
    helpUrl: null,
    appendToSent: true,
    domains: ['126.com'],
  },
  {
    id: 'aliyun-qiye',
    name: '阿里企业邮箱',
    imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '默认已开启 IMAP/SMTP；若管理员开启了“三方客户端安全密码”，密码栏填该安全密码。',
    helpUrl: 'https://help.aliyun.com/document_detail/36576.html',
    appendToSent: true,
    domains: [],
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '需在 Zoho Mail 设置里开启 IMAP 访问；开启两步验证时请生成“应用专用密码”。国区账号主机改为 imap.zoho.com.cn / smtp.zoho.com.cn。',
    helpUrl: 'https://www.zoho.com/mail/help/imap-access.html',
    appendToSent: true,
    domains: ['zoho.com', 'zohomail.com'],
  },
  {
    id: 'custom',
    name: '其他（手动填写）',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    authTypes: ['password'],
    oauthProvider: null,
    authHint: '向邮箱服务商查询 IMAP/SMTP 主机与端口；993/465 为 SSL，143/587 为 STARTTLS。',
    helpUrl: null,
    appendToSent: true,
    domains: [],
  },
]

export function presetById(id: string | null | undefined): EmailPreset | undefined {
  return id ? EMAIL_PRESETS.find((preset) => preset.id === id) : undefined
}

/** 免费邮箱域名：不参与“按域名关联客户”，建客户时不以域名当公司名 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.jp',
  'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.de', 'web.de', 'mail.ru', 'yandex.ru',
  'yandex.com', 'proton.me', 'protonmail.com', 'qq.com', 'foxmail.com', 'vip.qq.com', '163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com', 'zoho.com', 'naver.com', 'hanmail.net', 'rediffmail.com',
])
