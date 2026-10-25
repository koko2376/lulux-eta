import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ChatTurn, MessageAttachment, TurnImage } from "../../types.js";
import type { ModelCapabilities } from "../llm/capabilities.js";
import {
  IMAGE_MAX_BYTES,
  imageDimensions,
  MAX_IMAGES_PER_MESSAGE,
  sniffImageMime,
} from "../llm/images.js";
import { resolveInWorkspace } from "../tools/workspace.js";

/**
 * 图片输入（内置内核）：
 * - 历史里只有附件引用（turn.images 不带 data）；
 * - 上下文构建时按“新图优先”限制张数（较早的图先丢，正文里本来就有文件路径作为兜底）；
 * - 请求上游前才读文件内联 base64（inlineTurnImages），不写回历史；
 * - 模型不支持看图：去掉全部图片，只发文字（文件路径 + 浏览器上下文）。
 */

/** 一次请求最多带的图片张数 */
export const MAX_REQUEST_IMAGES = 16;
/** 只保留最近这么多条带图的用户消息里的图片 */
export const MAX_IMAGE_MESSAGES = 3;

export function attachmentImages(
  attachments: MessageAttachment[] | undefined,
): TurnImage[] | undefined {
  if (!attachments?.length) return undefined;
  const images = attachments
    .filter((a) => a.kind === "image")
    .map((a) => ({
      mime: a.mime,
      path: a.path,
      name: a.name,
      width: a.width,
      height: a.height,
    }));
  return images.length ? images : undefined;
}

function droppedNote(count: number): string {
  return `（此条消息附带的 ${count} 张图片已省略，以节省上下文；需要时可用文件路径查看）`;
}

/** 去掉某一轮的图片，并在正文后注明 */
function dropImages(turn: ChatTurn, note: boolean): number {
  const count = turn.images?.length ?? 0;
  if (!count) return 0;
  delete turn.images;
  if (note) turn.content = `${turn.content}\n\n${droppedNote(count)}`;
  return count;
}

/** 模型不支持看图：去掉全部图片（正文里已有路径），返回去掉的张数 */
export function stripAllImages(turns: ChatTurn[]): number {
  let n = 0;
  for (const turn of turns) n += dropImages(turn, false);
  return n;
}

/**
 * 限制图片：只保留最近 maxMessages 条带图用户消息的图片、总数不超过 maxImages（新图优先）。
 * 返回被丢掉的张数。
 */
export function limitImages(
  turns: ChatTurn[],
  maxImages = MAX_REQUEST_IMAGES,
  maxMessages = MAX_IMAGE_MESSAGES,
): number {
  let keptImages = 0;
  let keptMessages = 0;
  let dropped = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (!turn.images?.length) continue;
    if (keptMessages >= maxMessages || keptImages >= maxImages) {
      dropped += dropImages(turn, true);
      continue;
    }
    const room = maxImages - keptImages;
    if (turn.images.length > room) {
      const extra = turn.images.length - room;
      turn.images = turn.images.slice(0, room);
      turn.content = `${turn.content}\n\n${droppedNote(extra)}`;
      dropped += extra;
    }
    keptImages += turn.images.length;
    keptMessages += 1;
  }
  return dropped;
}

/** 去掉除最后一条带图用户消息之外的所有图片（上下文超预算时，先丢旧图再做文字压缩） */
export function dropOlderImages(turns: ChatTurn[]): number {
  let last = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]!.images?.length) {
      last = i;
      break;
    }
  }
  let dropped = 0;
  for (let i = 0; i < last; i += 1) dropped += dropImages(turns[i]!, true);
  return dropped;
}

/** 读取并校验一张工作区图片，返回 base64；失败返回错误说明 */
export async function loadWorkspaceImage(
  sessionId: string,
  path: string,
): Promise<{ data: string; mime: string } | { error: string }> {
  let abs: string;
  try {
    abs = resolveInWorkspace(sessionId, path).path;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { error: "不是文件" };
    if (info.size > IMAGE_MAX_BYTES) return { error: "图片超过 10 MB" };
    const buf = await readFile(abs);
    const mime = sniffImageMime(buf);
    if (!mime) return { error: "不是支持的图片格式" };
    return { data: buf.toString("base64"), mime };
  } catch {
    return { error: "文件不存在或已被删除" };
  }
}

/** 请求期缓存：同一次发言的工具循环里每张图只读一次 */
export type ImageCache = Map<
  string,
  { data: string; mime: string } | { error: string }
>;

/**
 * 请求上游前内联图片：返回新的轮次数组（带图的轮次是浅拷贝，原数组不变）。
 * 模型不支持看图时直接去掉图片；读不到的图片在正文后注明原因。
 */
export async function inlineTurnImages(
  turns: ChatTurn[],
  sessionId: string,
  caps: Pick<ModelCapabilities, "vision">,
  cache: ImageCache = new Map(),
): Promise<ChatTurn[]> {
  if (!turns.some((turn) => turn.images?.length)) return turns;
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    if (!turn.images?.length) {
      out.push(turn);
      continue;
    }
    if (!caps.vision) {
      const { images: _drop, ...rest } = turn;
      out.push(rest);
      continue;
    }
    const images: TurnImage[] = [];
    const problems: string[] = [];
    for (const image of turn.images) {
      if (image.data) {
        images.push(image);
        continue;
      }
      if (!image.path) continue;
      let loaded = cache.get(image.path);
      if (!loaded) {
        loaded = await loadWorkspaceImage(sessionId, image.path);
        cache.set(image.path, loaded);
      }
      if ("error" in loaded)
        problems.push(`${image.name || image.path}：${loaded.error}`);
      else images.push({ ...image, mime: loaded.mime, data: loaded.data });
    }
    const content = problems.length
      ? `${turn.content}\n\n（以下图片无法读取：${problems.join("；")}）`
      : turn.content;
    out.push({ ...turn, content, images: images.length ? images : undefined });
  }
  return out;
}

/**
 * 校验客户端提交的附件引用并补全元数据（发送消息时调用）：
 * 必须在本会话工作区内、是 png/jpg/webp/gif（按文件头判断）、单张 ≤ 10 MB、每条最多 8 张。
 * 校验失败抛错（文案给用户看）。
 */
export function resolveAttachments(
  sessionId: string,
  refs: Array<{ path: string; name?: string }>,
): MessageAttachment[] {
  if (refs.length > MAX_IMAGES_PER_MESSAGE)
    throw new Error(`每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const resolved = resolveInWorkspace(sessionId, ref.path);
    if (seen.has(resolved.rel)) continue;
    seen.add(resolved.rel);
    let size: number;
    try {
      const info = statSync(resolved.path);
      if (!info.isFile()) throw new Error("not file");
      size = info.size;
    } catch {
      throw new Error(`附件不存在：${ref.path}`);
    }
    if (size > IMAGE_MAX_BYTES) throw new Error(`图片超过 10 MB：${ref.path}`);
    const buf = readFileSync(resolved.path);
    const mime = sniffImageMime(buf);
    if (!mime)
      throw new Error(
        `不是支持的图片格式（png / jpg / webp / gif）：${ref.path}`,
      );
    const dims = imageDimensions(buf, mime);
    const name = (ref.name?.trim() || basename(resolved.rel)).slice(0, 200);
    out.push({
      kind: "image",
      path: resolved.rel,
      name,
      mime,
      size,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
  }
  return out;
}

/** 附件的本机绝对路径（CLI 内核用）；文件已不存在的跳过 */
export function attachmentAbsolutePaths(
  sessionId: string,
  attachments: MessageAttachment[] | undefined,
): string[] {
  const out: string[] = [];
  for (const attachment of attachments ?? []) {
    try {
      const abs = resolveInWorkspace(sessionId, attachment.path).path;
      if (statSync(abs).isFile()) out.push(abs);
    } catch {
      // 已删除或路径不合法：跳过
    }
  }
  return out;
}
