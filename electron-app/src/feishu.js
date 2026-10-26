// 飞书机器人接入：WebSocket 长连接（免公网 IP/回调地址），收到消息后抽取微信链接入流水线。
// 手机侧：微信文章 → 复制链接 → 飞书发给机器人；电脑未开机时消息留在飞书服务器，上线自动补处理。
const fs = require('fs');
const path = require('path');
const extract = require('./extract');
const store = require('./store');

const lark = require('@larksuiteoapi/node-sdk');

let wsClient = null;
let creds = null; // 当前连接用的 {appId, appSecret}
let api = null;   // 发消息用的 lark Client
let onUrlCb = null;

function log(msg) {
  try {
    fs.appendFileSync(path.join(store.DATA_DIR, 'app.log'),
      `${new Date().toISOString().slice(0, 19).replace('T', ' ')} [feishu] ${msg}\n`, 'utf8');
  } catch {}
}

function start(appId, appSecret, onUrl) {
  if (!appId || !appSecret) return { ok: false, reason: '缺少 App ID / Secret' };
  if (isRunning() && creds && creds.appId === appId && creds.appSecret === appSecret) return { ok: true };
  stop();
  creds = { appId, appSecret };
  onUrlCb = onUrl;
  try {
    api = new lark.Client({ appId, appSecret });
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const m = (data && data.message) || {};
          const raw = typeof m.content === 'string' ? m.content : '';
          // 链接从整个消息内容里找：text/post(富文本)/卡片消息都可能是链接载体
          const url = extract.firstWechatUrl(raw) || extract.firstPaperUrl(raw);
          log(`收到消息 type=${m.message_type} url=${url ? '✓' : '×'} raw=${raw.slice(0, 90)}`);
          if (url && m.chat_id) {
            onUrlCb && onUrlCb(url);
            // 轻量回执，让手机侧知道已收到
            try {
              await api.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: m.chat_id, content: JSON.stringify({ text: '✓ 已收到，处理中…' }), msg_type: 'text' },
              });
            } catch (e) {
              log(`回执发送失败：${e.message}`);
            }
          }
        } catch (e) {
          log(`消息处理异常：${e.message}`);
        }
      },
    });
    wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => log('连接已建立 ✓'),
      onError: (err) => log(`连接错误：${err.message}`),
      onReconnecting: () => log('重连中…'),
      onReconnected: () => log('已重连 ✓'),
    });
    wsClient.start({ eventDispatcher: dispatcher }).catch((e) => log(`start 失败：${e.message}`));
    // 10 秒后报一次连接状态，便于诊断
    setTimeout(() => {
      try { log(`连接状态：${wsClient ? JSON.stringify(wsClient.getConnectionStatus()) : '(已停止)'}`); } catch {}
    }, 10000);
    return { ok: true };
  } catch (e) {
    wsClient = null;
    return { ok: false, reason: e.message };
  }
}

function stop() {
  if (wsClient) {
    try { if (typeof wsClient.close === 'function') wsClient.close(); } catch {}
    wsClient = null;
  }
  creds = null;
  api = null;
}

function isRunning() {
  return !!wsClient;
}

module.exports = { start, stop, isRunning };
