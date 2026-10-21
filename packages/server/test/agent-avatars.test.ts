import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

/**
 * 头像是作者原版设计（0f0d587 的 packages/client/public/agents/*.png），不得替换。
 * 会话选择的是内核：原版头像对应各命令行内核；Gemini CLI / Qwen Code 没有 png，
 * 接口给产品图标、客户端显示原版 svg 标志。grok.png 给 Grok 内核（xAI Grok Build CLI）。
 */
const ORIGINAL_AVATARS: Record<string, string> = {
  builtin: "/icon.png",
  "kernel-hermes": "/agents/hermes.png",
  "kernel-claude-code": "/agents/claude.png",
  "kernel-codex": "/agents/codex.png",
  "kernel-pi": "/agents/pi.png",
  "kernel-grok": "/agents/grok.png",
  "kernel-gemini-cli": "/icon.png",
  "kernel-qwen-code": "/icon.png",
};

/** 原版文件的 sha256：防止被重新生成 / “美化”的图覆盖 */
const ORIGINAL_SHA256: Record<string, string> = {
  "/agents/claude.png":
    "0bff28b930e11b3fcaedfb9142af7d9c404899349e1bd594a80601aaae479362",
  "/agents/codex.png":
    "f2323639195d1eff51607df15fdf563166759b2efa36545b5cba9b27cacc0447",
  "/agents/grok.png":
    "0bc647fe3319d58663af8eb013d1541b47821af074b45e89ab9aaf5cc76b8458",
  "/agents/hermes.png":
    "8a9f7c4535795b6a7847c6752339f61f13d515afcb4c629d73f3ce71b3d87f41",
  "/agents/pi.png":
    "9262e2a9692abc071dd0994b84879b38bfa0bfed62913a1ac68b1303bce7ab06",
  "/icon.png":
    "15f687564a4a1f2c5f06b57c97bab03eb0e1ca924bac9348a7172c444f7d50ca",
};
const PUBLIC_DIR = fileURLToPath(
  new URL("../../client/public", import.meta.url),
);

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.close();
});

describe("Agent 头像 = 原版内核头像", () => {
  it("选择器只列内核：内置在前，各命令行内核指向原版头像", async () => {
    const res = await server.request("GET", "/api/agents");
    expect(res.status).toBe(200);
    const agents = res.json.agents as Array<{
      id: string;
      avatar: string;
      kind: string;
    }>;
    expect(agents.map((a) => a.id)).toEqual(Object.keys(ORIGINAL_AVATARS));
    expect(agents[0]).toMatchObject({ kind: "builtin", name: "LULUX" });
    expect(agents.slice(1).every((a) => a.kind === "kernel")).toBe(true);
    for (const [id, avatar] of Object.entries(ORIGINAL_AVATARS)) {
      expect(agents.find((a) => a.id === id)?.avatar, id).toBe(avatar);
    }
    // 不再出现后来生成的 lux-* / kernel-* 图
    expect(agents.some((a) => /\/agents\/(lux|kernel)-/.test(a.avatar))).toBe(
      false,
    );
  });

  it("头像文件与原版逐字节一致", () => {
    for (const [file, sha] of Object.entries(ORIGINAL_SHA256)) {
      const path = join(PUBLIC_DIR, file);
      expect(existsSync(path), path).toBe(true);
      expect(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        file,
      ).toBe(sha);
    }
  });

  it("用旧 persona id 建的会话，成员合并为内置内核", async () => {
    const created = await server.request("POST", "/api/sessions", {
      body: { agentIds: ["hermes", "claude"] },
    });
    expect(created.status).toBeLessThan(300);
    const session = created.json.session ?? created.json;
    expect(session.agentIds).toEqual(["builtin"]);
    const agents = (await server.request("GET", "/api/agents")).json
      .agents as Array<{ id: string; avatar: string }>;
    const avatars = session.agentIds.map(
      (id: string) => agents.find((a) => a.id === id)?.avatar,
    );
    expect(avatars).toEqual(["/icon.png"]);
    const mixed = await server.request("POST", "/api/sessions", {
      body: { agentIds: ["lux-writer", "kernel-pi", "lux-trade"] },
    });
    expect((mixed.json.session ?? mixed.json).agentIds).toEqual(["builtin", "kernel-pi"]);
  });
});
