// 仅用于本地验收的 OpenAI 兼容 mock 服务，验证 SSE 流式与产物提取
const http = require("node:http");

const PORT = Number(process.argv[2] || 51999);

const REPLY = [
  "好的，我按北欧客户常用的木屋规格整理了一版报价草稿。",
  "",
  "核心参数：",
  "- 主体落叶松胶合木，四面刨光",
  "- 屋面 300mm 岩棉保温，U 值 0.18",
  "- FOB Shanghai，30 天交期",
  "",
  "下面是一版可直接打印的报价单：",
  "",
  "```html",
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>Nordic Build AB 报价单</title>',
  "<style>body{font:14px/1.6 system-ui;padding:32px;color:#111}table{border-collapse:collapse;width:100%}",
  "td,th{border:1px solid #ddd;padding:8px;text-align:left}h1{font-size:18px}</style></head><body>",
  "<h1>报价单 · Nordic Build AB</h1>",
  "<table><tr><th>品名</th><th>规格</th><th>数量</th><th>单价</th></tr>",
  "<tr><td>木屋主体</td><td>60㎡ 落叶松</td><td>2 套</td><td>USD 18,400</td></tr>",
  "<tr><td>保温屋面</td><td>300mm 岩棉</td><td>2 套</td><td>USD 2,150</td></tr></table>",
  "<p>有效期 30 天，FOB Shanghai。</p></body></html>",
  "```",
  "",
  "另外附一个简版标识：",
  "",
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="18" fill="#111"/>',
  '<path d="M24 84 60 30l36 54z" fill="#fff"/><circle cx="60" cy="70" r="8" fill="#111"/></svg>',
  "```",
  "",
  "确认后我可以直接生成 PDF 并保存到该客户的报价记录里。",
].join("\n");

/** 和真实 OpenAI 一样带 id / object / created / model（严格解析的客户端，如 Grok Build，缺字段会报错） */
function envelope(payload) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    ...payload,
  };
}

function chunk(content) {
  return `data: ${JSON.stringify(envelope({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }))}\n\n`;
}

/*
 * 可编排模式（内置内核端到端测试用，默认行为不变）：
 *   POST /__mock/script  { responses: Step[] }  追加到队列；每个 /chat/completions 请求消费一个 Step
 *   GET  /__mock/requests                     已收到的请求体（含 headers 摘要）
 *   GET  /__mock/last                         最近一个请求体 + images（其中 image_url 内容块的摘要：mime、base64 长度、所在消息序号）
 *   POST /__mock/ignore  { systemContains: string[] }  系统提示含这些子串的旁路请求固定回 "ok"（不消费队列、不记录）
 *   POST /__mock/reset                        清空队列、记录与 ignore
 * 长期记忆自动提取的请求（系统提示含“【LULUX 记忆提取】”）只消费 { memory: true, text } 步骤，否则回 {"operations":[]}（不记录）。
 * Step 形如：
 *   { status: 429, headers: { 'retry-after': '0' }, body: '{"error":...}' }   直接返回错误
 *   { text, reasoning, toolCalls: [{ id?, name, arguments }], finish, usage, chunkSize, delayMs }
 *   { hang: true }                                                            只发头不发数据（测超时/停止）
 *   { text, dropAfter: true }                                                 发完 text 后断开连接（测中断续写）
 * 队列为空时：最后一条是 tool 结果 → 回复“工具结果：…”；最后一条用户消息带图片 → 回复“收到 N 张图片…”；
 * 否则回复固定 REPLY（与旧版一致）。
 */
const queue = [];
const requests = [];

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(envelope(payload))}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请求里的图片内容块摘要（OpenAI 多模态 content parts） */
function imageParts(body) {
  const out = [];
  (Array.isArray(body.messages) ? body.messages : []).forEach(
    (message, index) => {
      if (!Array.isArray(message.content)) return;
      for (const part of message.content) {
        if (part && part.type === "image_url") {
          const url = String((part.image_url && part.image_url.url) || "");
          const m = /^data:([^;]+);base64,(.*)$/.exec(url);
          out.push({
            message: index,
            role: message.role,
            mime: m ? m[1] : null,
            base64Length: m ? m[2].length : 0,
            dataUrl: Boolean(m),
          });
        }
      }
    },
  );
  return out;
}

async function playStep(step, res, body) {
  if (step.status && step.status >= 400) {
    res.writeHead(step.status, {
      "Content-Type": "application/json",
      ...(step.headers || {}),
    });
    res.end(
      step.body ||
        JSON.stringify({ error: { message: `mock error ${step.status}` } }),
    );
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (step.hang) {
    res.flushHeaders?.();
    return; // 不结束：由客户端超时或取消
  }
  const size = step.chunkSize || 8;
  const delay = step.delayMs ?? 2;
  for (const piece of (step.reasoning || "").match(/[\s\S]{1,8}/g) ?? []) {
    sse(res, {
      choices: [
        { index: 0, delta: { reasoning_content: piece }, finish_reason: null },
      ],
    });
    await sleep(delay);
  }
  for (const piece of (step.text || "").match(
    new RegExp(`[\\s\\S]{1,${size}}`, "g"),
  ) ?? []) {
    sse(res, {
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
    await sleep(delay);
  }
  if (step.dropAfter) {
    res.socket?.destroy();
    return;
  }
  (step.toolCalls || []).forEach((call, index) => {
    const args =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments || {});
    sse(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id || `call_${requests.length}_${index}`,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
        },
      ],
    });
    for (const part of args.match(/[\s\S]{1,16}/g) ?? []) {
      sse(res, {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: part } }] },
          },
        ],
      });
    }
  });
  const finish =
    step.finish || ((step.toolCalls || []).length ? "tool_calls" : "stop");
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  if (step.usage && body.stream_options && body.stream_options.include_usage)
    sse(res, { choices: [], usage: step.usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

const ignoreSystem = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.url === "/__mock/script" && req.method === "POST") {
      const data = JSON.parse(raw || "{}");
      queue.push(...(data.responses || []));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ queued: queue.length }));
      return;
    }
    if (req.url === "/__mock/requests") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(requests));
      return;
    }
    if (req.url === "/__mock/ignore" && req.method === "POST") {
      // 旁路请求（例如 CLI 自己生成会话标题）：系统提示含这些子串的请求固定回 "ok"，不消费队列、不记录
      ignoreSystem.push(...(JSON.parse(raw || "{}").systemContains || []));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"ok":true}');
      return;
    }
    if (req.url === "/__mock/last") {
      const last = requests[requests.length - 1] || null;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            request: last,
            images: last ? imageParts(last) : [],
          }),
        );
      return;
    }
    if (req.url === "/__mock/reset" && req.method === "POST") {
      queue.length = 0;
      requests.length = 0;
      ignoreSystem.length = 0;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"ok":true}');
      return;
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = {};
    }
    const system =
      Array.isArray(body.messages) &&
      body.messages[0] &&
      body.messages[0].role === "system"
        ? JSON.stringify(body.messages[0].content)
        : "";
    if (ignoreSystem.some((part) => system.includes(part))) {
      await playStep({ text: "ok" }, res, body);
      return;
    }
    // 长期记忆的后台自动提取（系统提示含“【LULUX 记忆提取】”）：只消费标了 memory: true 的编排步骤，
    // 否则固定回“没有要保存的”，不记录、不消费队列——避免空闲计时器触发的旁路请求抢走其他用例编排好的响应
    if (system.includes("【LULUX 记忆提取】")) {
      if (queue.length > 0 && queue[0] && queue[0].memory) {
        requests.push(body);
        await playStep(queue.shift(), res, body);
      } else {
        await playStep({ text: '{"operations":[]}' }, res, body);
      }
      return;
    }
    requests.push(body);

    if (queue.length > 0) {
      await playStep(queue.shift(), res, body);
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1];
    if (last && last.role === "tool") {
      await playStep(
        { text: `工具结果：${String(last.content).slice(0, 200)}` },
        res,
        body,
      );
      return;
    }
    const lastImages = imageParts(body).filter(
      (part) => part.message === messages.length - 1,
    );
    if (lastImages.length > 0) {
      await playStep(
        {
          text: `收到 ${lastImages.length} 张图片（${lastImages.map((p) => p.mime).join("、")}），我看到了截图里的内容。`,
        },
        res,
        body,
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const pieces = REPLY.match(/[\s\S]{1,24}/g) ?? [];
    for (const piece of pieces) {
      res.write(chunk(piece));
      await new Promise((r) => setTimeout(r, 18));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock-openai on ${PORT}`));
