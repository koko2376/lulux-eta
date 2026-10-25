import { ERROR_CATALOG, type CatalogEntry } from "./error-catalog.js";

/** Languages the server can answer error messages in. Messages are written in zh. */
export type ErrorLang = "zh" | "en";

const CJK = /[\u3400-\u9fff]/;

interface Compiled {
  code: string;
  zh: string;
  en: string;
  names: string[];
  regex: RegExp;
  /** Number of literal characters; longer literals are more specific and tried first */
  weight: number;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(code: string, [zh, en]: CatalogEntry): Compiled {
  const names: string[] = [];
  let pattern = "";
  let last = 0;
  for (const match of zh.matchAll(PLACEHOLDER)) {
    pattern += escapeRegex(zh.slice(last, match.index));
    pattern += "([\\s\\S]*?)";
    names.push(match[1]!);
    last = match.index! + match[0].length;
  }
  pattern += escapeRegex(zh.slice(last));
  return {
    code,
    zh,
    en,
    names,
    regex: new RegExp(`^${pattern}$`),
    weight: zh.replace(PLACEHOLDER, "").length,
  };
}

const byCode = new Map<string, Compiled[]>();
for (const [code, entries] of Object.entries(ERROR_CATALOG)) {
  byCode.set(
    code,
    entries
      .map((entry) => compile(code, entry))
      .sort((a, b) => b.weight - a.weight),
  );
}
const shared = byCode.get("_") ?? [];
const everything = [...byCode.values()]
  .flat()
  .sort((a, b) => b.weight - a.weight);

/**
 * Picks the error language for a request: `X-Lulux-Lang` (sent by the client with
 * its current UI language) wins; otherwise the first Accept-Language tag. Anything
 * that is not English keeps the original Chinese messages.
 */
export function errorLangFrom(
  headers: Record<string, string | string[] | undefined>,
): ErrorLang {
  const pick = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""))
      .trim()
      .toLowerCase();
  const explicit = pick(headers["x-lulux-lang"]);
  if (explicit) return explicit.startsWith("en") ? "en" : "zh";
  const accept = pick(headers["accept-language"]);
  if (!accept) return "zh";
  const tags = accept
    .split(",")
    .map((part, index) => {
      const [tag, ...rest] = part.trim().split(";");
      const q = rest.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return {
        tag: (tag ?? "").trim(),
        q: q ? Number(q.slice(2)) || 0 : 1,
        index,
      };
    })
    .filter((item) => item.tag && item.tag !== "*" && item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return tags[0]?.tag.startsWith("en") ? "en" : "zh";
}

type Params = Record<string, unknown>;

function fill(
  entry: Compiled,
  values: Map<string, string>,
  depth: number,
): string {
  return entry.en.replace(PLACEHOLDER, (raw, name: string, offset: number) => {
    const value = values.get(name);
    if (value === undefined) return raw;
    const translated = translateFragment(value, depth + 1);
    // a noun placed mid-sentence reads better in lower case ("modify customer you own")
    if (
      translated !== value &&
      /^[A-Z][a-z]/.test(translated) &&
      /[^.!?:]\s$/.test(entry.en.slice(0, offset))
    ) {
      return translated[0]!.toLowerCase() + translated.slice(1);
    }
    return translated;
  });
}

function tryEntries(
  entries: readonly Compiled[],
  message: string,
  params: Params | undefined,
  depth: number,
): string | null {
  for (const entry of entries) {
    const match = entry.regex.exec(message);
    if (!match) continue;
    const values = new Map<string, string>();
    entry.names.forEach((name, index) =>
      values.set(name, match[index + 1] ?? ""),
    );
    if (params)
      for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== null)
          values.set(key, String(value));
    return fill(entry, values, depth);
  }
  return null;
}

/** Translates a dynamic part: nouns, nested messages, or `、`-joined lists of them */
function translateFragment(value: string, depth: number): string {
  if (!CJK.test(value) || depth > 4) return value;
  const whole =
    tryEntries(shared, value, undefined, depth) ??
    tryEntries(everything, value, undefined, depth);
  if (whole !== null) return whole;
  if (value.includes("、"))
    return value
      .split("、")
      .map((part) => translateFragment(part, depth + 1))
      .join(", ");
  return value;
}

/**
 * Translates an error message for `lang`. Messages are matched against the
 * catalog entries of their code first, then the shared entries, then every other
 * code. When nothing matches, the original message is returned unchanged.
 */
export function translateErrorMessage(
  code: string,
  message: string,
  lang: ErrorLang,
  params?: Params,
): string {
  if (lang === "zh" || !message || !CJK.test(message)) return message;
  const own = byCode.get(code) ?? [];
  return (
    tryEntries(own, message, params, 0) ??
    tryEntries(shared, message, params, 0) ??
    tryEntries(everything, message, params, 0) ??
    message
  );
}

/** Validation failures are `参数校验失败（path：issue；path：issue）`; each part is translated separately */
export function translateValidationMessage(
  message: string,
  lang: ErrorLang,
): string | null {
  if (lang === "zh") return null;
  const match = /^参数校验失败（([\s\S]*)）$/.exec(message);
  if (!match) return null;
  const parts = match[1]!.split("；").map((part) => {
    const index = part.indexOf("：");
    if (index < 0) return translateFragment(part, 1);
    const path = part.slice(0, index);
    const issue = part.slice(index + 1);
    return `${path === "请求体" ? "body" : path}: ${translateFragment(issue, 1)}`;
  });
  return `Validation failed (${parts.join("; ")})`;
}
