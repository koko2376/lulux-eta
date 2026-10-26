import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSse, startTestServer, type TestServer } from "./helpers.js";

/**
 * 图片输入（vision）：格式识别 / 尺寸、各 Provider 请求构建、不支持看图的文字兜底与降级、
 * 上下文里的图片限额（新图优先）、网关转发、CLI 参数，以及经 mock-openai 的端到端（图片内容块真的到达上游）。
 */

// 1×1 PNG
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngBuf = Buffer.from(PNG_1X1, "base64");

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  // SOI + APP0(16) + SOF0
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

let server: TestServer;
let mock: ChildProcess;
let mockBase = "";
let upstream: Server;
let upstreamUrl = "";
const received: any[] = [];
type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void;
const handlers: Handler[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function mockCall(path: string, body?: unknown): Promise<any> {
  const get =
    body === undefined &&
    (path === "/__mock/requests" || path === "/__mock/last");
  const res = await fetch(`${mockBase}${path}`, {
    method: get ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: get ? undefined : JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function settings(patch: Record<string, unknown>): Promise<void> {
  const res = await server.request("PATCH", "/api/settings", { body: patch });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function newSession(): Promise<string> {
  const res = await server.request("POST", "/api/sessions", {
    body: { agentIds: ["builtin"] },
  });
  return res.json.session.id;
}

async function upload(
  sessionId: string,
  path: string,
  data: Buffer,
): Promise<void> {
  const res = await server.request(
    "POST",
    `/api/chat/sessions/${sessionId}/files`,
    {
      body: { path, dataBase64: data.toString("base64"), overwrite: true },
    },
  );
  expect(res.status, res.text).toBe(201);
}

function sseOk(res: ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

beforeAll(async () => {
  const port = await freePort();
  mock = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../tools/dev/mock-openai.js", import.meta.url),
      ),
      String(port),
    ],
    { stdio: "pipe" },
  );
  await new Promise<void>((ready) => mock.stdout!.once("data", () => ready()));
  mockBase = `http://127.0.0.1:${port}`;

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : {};
      received.push(body);
      const handler = handlers.shift();
      if (!handler) res.writeHead(500).end("no handler");
      else handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  server = await startTestServer();
  const provider = await server.request("POST", "/api/providers", {
    body: {
      name: "Mock",
      kind: "openai",
      baseUrl: `${mockBase}/v1`,
      apiKey: "sk-mock-key-123456",
      model: "mock-model",
    },
  });
  expect(provider.status).toBe(201);
  await settings({ autoTitle: false, llmMaxRetries: 0, builtinTools: false });
}, 30_000);

afterAll(async () => {
  mock?.kill();
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  await server?.close();
});

beforeEach(async () => {
  await mockCall("/__mock/reset");
  received.length = 0;
  handlers.length = 0;
});

describe("图片格式与尺寸", () => {
  it("按文件头识别 png/jpeg/gif/webp，读取宽高；估算 token 有上限", async () => {
    const {
      sniffImageMime,
      imageDimensions,
      estimateImageTokens,
      parseImageDataUrl,
      imageMimeFromName,
    } = await import("../src/services/llm/images.js");
    expect(sniffImageMime(pngBuf)).toBe("image/png");
    expect(imageDimensions(pngHeader(1920, 1080), "image/png")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(sniffImageMime(jpegHeader(640, 480))).toBe("image/jpeg");
    expect(imageDimensions(jpegHeader(640, 480), "image/jpeg")).toEqual({
      width: 640,
      height: 480,
    });
    const gif = Buffer.from("GIF89a\x20\x03\x58\x02", "latin1");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(imageDimensions(gif, "image/gif")).toEqual({
      width: 800,
      height: 600,
    });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(1023, 24, 3);
    webp.writeUIntLE(767, 27, 3);
    expect(sniffImageMime(webp)).toBe("image/webp");
    expect(imageDimensions(webp, "image/webp")).toEqual({
      width: 1024,
      height: 768,
    });
    expect(sniffImageMime(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(
      estimateImageTokens({ width: 4000, height: 3000 }),
    ).toBeLessThanOrEqual(1600);
    expect(estimateImageTokens({ width: 64, height: 64 })).toBeGreaterThan(0);
    expect(parseImageDataUrl("data:image/jpg;base64,AAAA")).toEqual({
      mime: "image/jpeg",
      data: "AAAA",
    });
    expect(parseImageDataUrl("https://example.com/a.png")).toBeNull();
    expect(imageMimeFromName("a.JPG")).toBe("image/jpeg");
  });
});

describe("Provider 请求构建", () => {
  it("OpenAI 兼容：用户轮次变成 text + image_url(data URL) 内容块；未内联的图片不发", async () => {
    const { streamOpenAIExtended } =
      await import("../src/services/llm/openai.js");
    handlers.push((_req, _body, res) => sseOk(res, "ok"));
    const events = [];
    for await (const event of streamOpenAIExtended({
      baseUrl: upstreamUrl,
      apiKey: "k",
      model: "gpt-4o",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: "看图",
          images: [
            { mime: "image/png", data: PNG_1X1 },
            { mime: "image/png", path: "x.png" },
          ],
        },
        { role: "assistant", content: "好" },
        { role: "user", content: "再看" },
      ],
    }))
      events.push(event);
    expect(events.some((e) => e.type === "text")).toBe(true);
    const body = received[0];
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "看图" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PNG_1X1}` },
        },
      ],
    });
    expect(body.messages[3]).toEqual({ role: "user", content: "再看" });
  });

  it("Anthropic：image(base64) 块在文字前；超过 5 MB 的图片降级为文字说明", async () => {
    const { streamAnthropicExtended } =
      await import("../src/services/llm/anthropic.js");
    handlers.push((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
      );
    });
    const big = "A".repeat(Math.ceil((5 * 1024 * 1024 + 10) / 3) * 4);
    for await (const _ of streamAnthropicExtended({
      baseUrl: upstreamUrl,
      apiKey: "k",
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: "这是什么",
          images: [
            { mime: "image/jpeg", data: PNG_1X1 },
            { mime: "image/png", data: big, name: "huge.png" },
          ],
        },
      ],
    }))
      void _;
    const content = received[0].messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: PNG_1X1 },
    });
    expect(content).toHaveLength(2);
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("这是什么");
    expect(content[1].text).toContain("huge.png");
  });

  it("上游拒绝图片：记住该模型不看图、去掉图片重发，下发 vision 降级", async () => {
    const { streamResilient } =
      await import("../src/services/llm/resilient.js");
    const { capabilitiesFor, learnCapability } =
      await import("../src/services/llm/capabilities.js");
    learnCapability("img-reject-model", { vision: true });
    handlers.push((_req, _body, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "This model does not support image input" },
        }),
      );
    });
    handlers.push((_req, _body, res) => sseOk(res, "text only"));
    const downgrades: string[] = [];
    for await (const _ of streamResilient(
      "openai",
      {
        baseUrl: upstreamUrl,
        apiKey: "k",
        model: "img-reject-model",
        messages: [
          {
            role: "user",
            content: "图：uploads/a.png",
            images: [{ mime: "image/png", data: PNG_1X1 }],
          },
        ],
      },
      {
        maxRetries: 0,
        timeoutMs: 5000,
        onDowngrade: (what) => downgrades.push(what),
      },
    ))
      void _;
    expect(downgrades).toEqual(["vision"]);
    expect(received[1].messages[0]).toEqual({
      role: "user",
      content: "图：uploads/a.png",
    });
    // 降级按 Provider（接口地址）+ 模型记
    expect(capabilitiesFor("img-reject-model", { kind: "openai", baseUrl: upstreamUrl }).vision).toBe(false);
  });
});

describe("上下文里的图片", () => {
  it("limitImages：只保留最近 3 条消息、最多 16 张（新图优先），被丢的注明；dropOlderImages 只留最后一条", async () => {
    const { limitImages, dropOlderImages, stripAllImages, inlineTurnImages } =
      await import("../src/services/chat/vision.js");
    const img = { mime: "image/png", path: "a.png" };
    const make = () =>
      [1, 2, 3, 4].map((i) => ({
        role: "user" as const,
        content: `m${i}`,
        images: Array.from({ length: i === 4 ? 10 : 4 }, () => ({ ...img })),
      }));
    const turns = make();
    expect(limitImages(turns)).toBe(4 + 2);
    expect(turns[0]!.images).toBeUndefined();
    expect(turns[0]!.content).toContain("4 张图片已省略");
    expect(turns[1]!.images).toHaveLength(2);
    expect(turns[3]!.images).toHaveLength(10);
    const again = make();
    expect(dropOlderImages(again)).toBe(12);
    expect(again.filter((t) => t.images).length).toBe(1);
    const plain = make();
    expect(stripAllImages(plain)).toBe(22);
    expect(plain[0]!.content).toBe("m1");
    // 不支持看图：内联时直接去掉，不读文件
    const out = await inlineTurnImages(
      [{ role: "user", content: "x", images: [img] }],
      "sess_x",
      { vision: false },
    );
    expect(out[0]).toEqual({ role: "user", content: "x" });
  });

  it("历史只带引用：turnsForMessage 给用户轮次挂 images（无 data）；内核提示词列出绝对路径", async () => {
    const { turnsForMessage, buildKernelPrompt } =
      await import("../src/services/chat/history.js");
    const message = {
      id: "m1",
      sessionId: "s",
      role: "user" as const,
      content: "看这个",
      senderAgentId: null,
      toolTrace: [],
      toolRounds: [],
      runtime: null,
      reasoning: "",
      usage: null,
      finishReason: null,
      createdAt: 1,
      attachments: [
        {
          kind: "image" as const,
          path: "uploads/a.png",
          name: "a.png",
          mime: "image/png",
          size: 10,
          width: 1,
          height: 1,
        },
      ],
    };
    const speaker = {
      id: "builtin",
      kind: "builtin",
      name: "LULUX",
      description: "",
      persona: "",
    } as any;
    const turns = turnsForMessage(
      message,
      speaker,
      "builtin",
      new Set(),
      () => undefined,
    );
    expect(turns[0]!.images).toEqual([
      {
        mime: "image/png",
        path: "uploads/a.png",
        name: "a.png",
        width: 1,
        height: 1,
      },
    ]);
    const prompt = buildKernelPrompt([message], speaker, () => undefined, [
      "/data/ws/s/uploads/a.png",
    ]);
    expect(prompt).toContain("看这个");
    expect(prompt).toContain("- /data/ws/s/uploads/a.png");
  });
});

describe("网关转发图片", () => {
  it("各协议的 base64 图片转成规范 images；工具结果里的图片随后面的 user 轮次转发；远程 URL 用占位", async () => {
    const { anthropicToCanonical } =
      await import("../src/services/gateway/anthropic.js");
    const { chatToCanonical } =
      await import("../src/services/gateway/openai-chat.js");
    const { responsesToCanonical } =
      await import("../src/services/gateway/responses.js");
    const { geminiToCanonical } =
      await import("../src/services/gateway/gemini.js");
    const a = anthropicToCanonical({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: PNG_1X1,
              },
            },
            { type: "text", text: "看" },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/x.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: "BBBB",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(a.turns[0]).toEqual({
      role: "user",
      content: "看",
      images: [{ mime: "image/png", data: PNG_1X1 }],
    });
    expect(a.turns[2]).toMatchObject({ role: "tool", toolCallId: "t1" });
    expect(a.turns[3]).toMatchObject({
      role: "user",
      images: [{ mime: "image/jpeg", data: "BBBB" }],
    });
    expect(a.turns[3]!.content).toContain("工具返回的图片 1 张");

    const c = chatToCanonical({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "q" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${PNG_1X1}` },
            },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    });
    expect(c.turns[0]!.images).toEqual([{ mime: "image/png", data: PNG_1X1 }]);
    expect(c.turns[0]!.content).toContain("网关只能转发内联图片");

    const r = responsesToCanonical({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hi" },
            { type: "input_image", image_url: `data:image/webp;base64,CCCC` },
          ],
        },
      ],
    });
    expect(r.turns[0]).toEqual({
      role: "user",
      content: "hi",
      images: [{ mime: "image/webp", data: "CCCC" }],
    });

    const g = geminiToCanonical(
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "g" },
              { inlineData: { mimeType: "image/png", data: "DDDD" } },
            ],
          },
        ],
      },
      "m",
      false,
    );
    expect(g.turns[0]).toEqual({
      role: "user",
      content: "g",
      images: [{ mime: "image/png", data: "DDDD" }],
    });
  });
});

describe("CLI 内核的图片参数", () => {
  it("Codex 用原生 --image（放在 exec 后、stdin 的 - 之前）；Claude Code --add-dir；Gemini/Qwen --include-directories；其他只给路径", async () => {
    const { kernelImageArgs } =
      await import("../src/services/kernels/kernel-runner.js");
    const files = ["/ws/s1/uploads/a.png", "/ws/s1/uploads/b.jpg"];
    expect(
      kernelImageArgs({ id: "codex" }, ["exec", "--json", "-"], files),
    ).toEqual([
      "exec",
      "--image",
      files[0],
      "--image",
      files[1],
      "--json",
      "-",
    ]);
    expect(kernelImageArgs({ id: "claude-code" }, ["-p"], files)).toEqual([
      "-p",
      "--add-dir=/ws/s1/uploads",
    ]);
    expect(kernelImageArgs({ id: "gemini-cli" }, ["-p", " "], files)).toEqual([
      "-p",
      " ",
      "--include-directories=/ws/s1/uploads",
    ]);
    expect(kernelImageArgs({ id: "qwen-code" }, [], files)).toEqual([
      "--include-directories=/ws/s1/uploads",
    ]);
    expect(kernelImageArgs({ id: "other" }, ["x"], files)).toEqual(["x"]);
    expect(kernelImageArgs({ id: "codex" }, ["exec", "-"], [])).toEqual([
      "exec",
      "-",
    ]);
  });
});

describe("端到端：图片经内置内核到达上游（mock-openai）", () => {
  it("支持看图的模型：image_url 数据块到达上游；消息只存引用，不存 base64", async () => {
    await settings({
      modelCapabilities: JSON.stringify({ "mock-model": { vision: true } }),
    });
    const sessionId = await newSession();
    await upload(sessionId, "uploads/shot.png", pngBuf);
    await upload(sessionId, "uploads/two.png", pngBuf);
    const res = await server.request("POST", "/api/chat", {
      body: {
        sessionId,
        content:
          "帮我看看这两张图\n\n（附件已上传到会话工作区：uploads/shot.png、uploads/two.png）",
        attachments: [
          { path: "uploads/shot.png" },
          { path: "uploads/two.png", name: "第二张.png" },
        ],
      },
    });
    expect(res.status, res.text).toBe(200);
    const events = parseSse(res.text);
    expect(events.find((e) => e.event === "error")).toBeUndefined();
    expect(events.find((e) => e.event === "vision")).toBeUndefined();
    const last = await mockCall("/__mock/last");
    expect(last.images).toHaveLength(2);
    expect(last.images[0]).toMatchObject({
      role: "user",
      mime: "image/png",
      dataUrl: true,
      base64Length: PNG_1X1.length,
    });
    const done = events.find((e) => e.event === "done")!.data.message;
    expect(done.content).toContain("收到 2 张图片");

    const session = await server.request("GET", `/api/sessions/${sessionId}`);
    const user = session.json.messages.find((m: any) => m.role === "user");
    expect(user.attachments).toEqual([
      {
        kind: "image",
        path: "uploads/shot.png",
        name: "shot.png",
        mime: "image/png",
        size: pngBuf.length,
        width: 1,
        height: 1,
      },
      {
        kind: "image",
        path: "uploads/two.png",
        name: "第二张.png",
        mime: "image/png",
        size: pngBuf.length,
        width: 1,
        height: 1,
      },
    ]);
    expect(JSON.stringify(session.json)).not.toContain(PNG_1X1.slice(0, 40));

    // 后续轮次：历史里的图仍按引用内联（同一会话第二问）
    await mockCall("/__mock/reset");
    const follow = await server.request("POST", "/api/chat", {
      body: { sessionId, content: "第一张是什么颜色？" },
    });
    expect(follow.status).toBe(200);
    const again = await mockCall("/__mock/last");
    expect(again.images).toHaveLength(2);
    expect(again.images[0].message).toBeLessThan(
      again.request.messages.length - 1,
    );
  });

  it("不支持看图的模型：不发图片内容块，正文里的路径照样送达，并下发 vision 提示", async () => {
    await settings({ modelCapabilities: "" });
    const sessionId = await newSession();
    await upload(sessionId, "uploads/shot.png", pngBuf);
    const res = await server.request("POST", "/api/chat", {
      body: {
        sessionId,
        content: "看图\n\n（附件已上传到会话工作区：uploads/shot.png）",
        attachments: [{ path: "uploads/shot.png" }],
      },
    });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const vision = events.findIndex((e) => e.event === "vision");
    expect(events[vision]?.data).toEqual({
      agentId: "builtin",
      supported: false,
      model: "mock-model",
      images: 1,
    });
    // 在 agent 事件之后（客户端在 agent 事件时清空提示）
    expect(vision).toBeGreaterThan(
      events.findIndex((e) => e.event === "agent"),
    );
    const last = await mockCall("/__mock/last");
    expect(last.images).toHaveLength(0);
    const user = last.request.messages[last.request.messages.length - 1];
    expect(typeof user.content).toBe("string");
    expect(user.content).toContain("uploads/shot.png");
  });

  it("只有图片没有文字也能发送；编辑重发默认沿用原附件", async () => {
    await settings({
      modelCapabilities: JSON.stringify({ "mock-model": { vision: true } }),
    });
    const sessionId = await newSession();
    await upload(sessionId, "uploads/only.png", pngBuf);
    const res = await server.request("POST", "/api/chat", {
      body: {
        sessionId,
        content: "",
        attachments: [{ path: "uploads/only.png" }],
      },
    });
    expect(res.status, res.text).toBe(200);
    expect((await mockCall("/__mock/last")).images).toHaveLength(1);
    const session = await server.request("GET", `/api/sessions/${sessionId}`);
    const user = session.json.messages.find((m: any) => m.role === "user");
    await mockCall("/__mock/reset");
    const edit = await server.request("POST", "/api/chat/edit", {
      body: {
        sessionId,
        messageId: user.id,
        content: "改一下：这张图是什么？",
      },
    });
    expect(edit.status, edit.text).toBe(200);
    const last = await mockCall("/__mock/last");
    expect(last.images).toHaveLength(1);
    const after = await server.request("GET", `/api/sessions/${sessionId}`);
    expect(
      after.json.messages.find((m: any) => m.role === "user").attachments,
    ).toHaveLength(1);
  });

  it("附件校验：超过 8 张、非图片、工作区外路径、不存在的文件都拒绝（400）", async () => {
    const sessionId = await newSession();
    await upload(sessionId, "uploads/a.png", pngBuf);
    await upload(sessionId, "uploads/doc.pdf", Buffer.from("%PDF-1.7 fake"));
    const send = (attachments: unknown) =>
      server.request("POST", "/api/chat", {
        body: { sessionId, content: "x", attachments },
      });
    expect(
      (await send(Array.from({ length: 9 }, () => ({ path: "uploads/a.png" }))))
        .status,
    ).toBe(400);
    const pdf = await send([{ path: "uploads/doc.pdf" }]);
    expect(pdf.status).toBe(400);
    expect(pdf.json.error.code).toBe("INVALID_ATTACHMENT");
    expect((await send([{ path: "../../etc/passwd" }])).status).toBe(400);
    expect(
      (await send([{ path: "uploads/missing.png" }])).json.error.message,
    ).toContain("附件不存在");
    expect(
      (
        await server.request("POST", "/api/chat", {
          body: { sessionId, content: "   " },
        })
      ).status,
    ).toBe(400);
  });

  it("多条带图消息：请求里只带最近 3 条消息的图片（旧图先省略）", async () => {
    await settings({
      modelCapabilities: JSON.stringify({ "mock-model": { vision: true } }),
    });
    const sessionId = await newSession();
    await upload(sessionId, "uploads/a.png", pngBuf);
    for (let i = 1; i <= 4; i += 1) {
      const res = await server.request("POST", "/api/chat", {
        body: {
          sessionId,
          content: `第 ${i} 张`,
          attachments: [{ path: "uploads/a.png" }],
        },
      });
      expect(res.status).toBe(200);
    }
    const last = await mockCall("/__mock/last");
    expect(last.images).toHaveLength(3);
    const first = last.request.messages.find(
      (m: any) =>
        typeof m.content === "string" && m.content.startsWith("第 1 张"),
    );
    expect(first.content).toContain("图片已省略");
  });
});
