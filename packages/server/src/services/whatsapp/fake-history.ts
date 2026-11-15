/**
 * 假引擎的历史同步样本：按引擎原始数据的形状（chats / contacts / messages，时间戳为秒或 Long），
 * 经同一个映射函数转换，用于单测与浏览器验收。绝不用于生产。
 */
const DAY = 86_400_000

export const FAKE_HISTORY_CUSTOMER = {
  jid: '15555550101@s.whatsapp.net',
  phone: '+15555550101',
  name: 'Acme 采购 Lisa',
}
export const FAKE_HISTORY_LID_CUSTOMER = {
  lid: '123456789012345@lid',
  jid: '15555550102@s.whatsapp.net',
  phone: '+15555550102',
  pushName: 'Jonas',
}

function long(seconds: number): { low: number; high: number; unsigned: boolean } {
  return { low: seconds >>> 0, high: Math.floor(seconds / 4_294_967_296), unsigned: true }
}

function key(remoteJid: string, id: string, fromMe = false) {
  return { remoteJid, id, fromMe }
}

/** 两批历史 + 一条实时“自己从手机发出”的消息 */
export function fakeHistoryPayloads(now = Date.now()): { batches: any[]; ownMessage: any } {
  const sec = (daysAgo: number) => Math.floor((now - daysAgo * DAY) / 1000)
  const a = FAKE_HISTORY_CUSTOMER
  const b = FAKE_HISTORY_LID_CUSTOMER
  const first = {
    isLatest: true,
    progress: 40,
    chats: [
      { id: a.jid, name: a.name, unreadCount: 2 },
      { id: b.lid, pnJid: b.jid, unreadCount: 0 },
      { id: '120363000000000000@g.us', name: '群聊' },
    ],
    contacts: [{ id: a.jid, name: a.name }],
    messages: [
      { key: key(a.jid, 'hist-a-1'), messageTimestamp: sec(10), pushName: 'Lisa', message: { conversation: 'Hi, can you send the price list?' } },
      { key: key(a.jid, 'hist-a-2', true), messageTimestamp: long(sec(9)), pushName: '我自己', message: { extendedTextMessage: { text: 'Sure, attached.' } } },
      { key: key(a.jid, 'hist-a-3'), messageTimestamp: String(sec(8)), message: { imageMessage: { caption: 'our logo', mimetype: 'image/jpeg' } } },
      { key: key(a.jid, 'hist-a-old'), messageTimestamp: sec(120), message: { conversation: 'too old to import' } },
      { key: key('120363000000000000@g.us', 'hist-group'), messageTimestamp: sec(5), message: { conversation: 'group chatter' } },
      { key: key(a.jid, 'hist-a-proto'), messageTimestamp: sec(7), message: { protocolMessage: { type: 0 } } },
    ],
  }
  const second = {
    isLatest: false,
    progress: 100,
    chats: [],
    contacts: [
      { id: a.jid, notify: 'Lisa' },
      { id: b.lid, notify: b.pushName },
    ],
    messages: [
      // 与第一批重复：不能写两次
      { key: key(a.jid, 'hist-a-1'), messageTimestamp: sec(10), message: { conversation: 'Hi, can you send the price list?' } },
      { key: key(b.lid, 'hist-b-1'), messageTimestamp: sec(3), message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'Guten Tag, I need 500 units.' } } } } },
      { key: key(b.lid, 'hist-b-2'), messageTimestamp: sec(2), message: { audioMessage: { ptt: true } } },
    ],
  }
  const ownMessage = {
    key: key(a.jid, `live-own-${now}`, true),
    messageTimestamp: Math.floor(now / 1000),
    message: { conversation: 'Sent from my phone' },
  }
  return { batches: [first, second], ownMessage }
}
