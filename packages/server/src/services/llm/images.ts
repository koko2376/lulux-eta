import type { TurnImage } from "../../types.js";

/**
 * 图片输入的公共工具：格式识别（按文件头，不信扩展名）、尺寸读取（只读文件头，不解码像素）、token 估算。
 * 服务端不做缩放（没有无依赖的解码方式）：客户端上传前用 canvas 把长边压到 2048 px 以内，服务端只做大小限制。
 */

export const IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** 单张图片上限（与会话工作区上传上限一致） */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 每条消息最多附带的图片数 */
export const MAX_IMAGES_PER_MESSAGE = 8;
/** 客户端缩放目标：长边像素 */
export const IMAGE_MAX_EDGE = 2048;
/** Anthropic 单张图片上限（解码后 5 MB）；超过的图片对该接口降级为文字 */
export const ANTHROPIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EXT_MIME: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 按扩展名判断是否是支持的图片（只用于快速筛选，真正的格式以文件头为准） */
export function imageMimeFromName(name: string): ImageMime | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_MIME[ext] ?? null;
}

/** 按文件头识别图片格式；不是支持的格式返回 null */
export function sniffImageMime(buf: Uint8Array): ImageMime | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  )
    return "image/gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function u32be(b: Uint8Array, o: number): number {
  return (
    ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!)
  );
}

/** 读取图片宽高（PNG IHDR / GIF 逻辑屏幕 / JPEG SOFn / WebP VP8 VP8L VP8X）；无法判断返回 null */
export function imageDimensions(
  buf: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (mime === "image/png") {
      if (buf.length < 24) return null;
      return { width: u32be(buf, 16), height: u32be(buf, 20) };
    }
    if (mime === "image/gif") {
      if (buf.length < 10) return null;
      return { width: u16le(buf, 6), height: u16le(buf, 8) };
    }
    if (mime === "image/jpeg") {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) {
          o += 1;
          continue;
        }
        const marker = buf[o + 1]!;
        if (
          marker === 0xd8 ||
          marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)
        ) {
          o += 2;
          continue;
        }
        const len = u16be(buf, o + 2);
        // SOF0..SOF15，除去 DHT(C4) / JPG(C8) / DAC(CC)
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return { width: u16be(buf, o + 7), height: u16be(buf, o + 5) };
        }
        o += 2 + len;
      }
      return null;
    }
    if (mime === "image/webp") {
      if (buf.length < 30) return null;
      const chunk = String.fromCharCode(buf[12]!, buf[13]!, buf[14]!, buf[15]!);
      if (chunk === "VP8 ")
        return {
          width: u16le(buf, 26) & 0x3fff,
          height: u16le(buf, 28) & 0x3fff,
        };
      if (chunk === "VP8L") {
        const b0 = buf[21]!,
          b1 = buf[22]!,
          b2 = buf[23]!,
          b3 = buf[24]!;
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      if (chunk === "VP8X")
        return { width: 1 + u24le(buf, 24), height: 1 + u24le(buf, 27) };
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 一张图片的输入 token 估算（只用于上下文预算）：
 * Anthropic ≈ 宽×高/750（长边超过 1568 会被缩放，单张上限约 1600）；OpenAI high detail 512 块 ×170 + 85。
 * 取两者里较大的一个，未知尺寸按 1600。
 */
export function estimateImageTokens(
  image: Pick<TurnImage, "width" | "height">,
): number {
  const w = image.width ?? 0;
  const h = image.height ?? 0;
  if (!w || !h) return 1600;
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const anthropic = Math.ceil((w * scale * h * scale) / 750);
  const fit = Math.min(1, 2048 / Math.max(w, h));
  let ow = w * fit;
  let oh = h * fit;
  const shortFit = Math.min(1, 768 / Math.min(ow, oh));
  ow *= shortFit;
  oh *= shortFit;
  const openai = 85 + 170 * Math.ceil(ow / 512) * Math.ceil(oh / 512);
  return Math.min(1600, Math.max(anthropic, openai, 85));
}

/** base64 解码后的字节数 */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** data:image/png;base64,xxxx → { mime, data }；不是 base64 图片 data URL 返回 null */
export function parseImageDataUrl(
  url: string,
): { mime: string; data: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(
    url.trim(),
  );
  if (!match) return null;
  const mime =
    match[1]!.toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : match[1]!.toLowerCase();
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) return null;
  return { mime, data: match[2]!.replace(/\s+/g, "") };
}
