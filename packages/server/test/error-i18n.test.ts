import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "../src/i18n/error-catalog.js";
import {
  errorLangFrom,
  translateErrorMessage,
  translateValidationMessage,
} from "../src/i18n/error-messages.js";
import { startTestServer, type TestServer } from "./helpers.js";

const SRC = join(__dirname, "..", "src");
const CJK = /[\u3400-\u9fff]/;

/**
 * Messages that are intentionally left untranslated (shown in Chinese in every
 * UI language). Keep this list short; add a catalog entry instead whenever possible.
 * Format: `${code}|${zhTemplate}`.
 */
const ALLOWLIST = new Set<string>([]);

interface Site {
  where: string;
  code: string;
  /** zh template, dynamic parts as {0}, {1} … */
  template: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !path.includes(`${join("src", "i18n")}`))
      out.push(path);
  }
  return out;
}

function templateOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    node.templateSpans.forEach(
      (span, index) => (text += `{${index}}${span.literal.text}`),
    );
    return text;
  }
  return null;
}

const HELPER_ERRORS =
  /(?:^|\.)(SpecError|DagError|SkillFormatError|FrontmatterError|SkillPackageError|ZipError|SecretUnavailableError)$/;
const ZOD_METHODS = new Set([
  "min",
  "max",
  "refine",
  "regex",
  "email",
  "length",
  "int",
  "positive",
  "nonnegative",
  "nonempty",
  "superRefine",
  "url",
]);

/** Every Chinese literal that can end up as an HTTP error message */
function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const add = (
      node: ts.Node,
      code: string,
      message: ts.Node | undefined,
    ): void => {
      const template = message ? templateOf(message) : null;
      if (!template || !CJK.test(template)) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      sites.push({ where: `${relative(SRC, file)}:${line}`, code, template });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const callee = node.expression.getText(sf);
        const args = node.arguments ?? [];
        if (
          (callee === "AppError" || callee === "MemoryError") &&
          args.length >= 3 &&
          ts.isStringLiteralLike(args[1]!)
        ) {
          add(node, (args[1] as ts.StringLiteralLike).text, args[2]);
        } else if (callee === "ReauthRequiredError") {
          add(node, "EMAIL_REAUTH_REQUIRED", args[0]);
        } else if (HELPER_ERRORS.test(callee)) {
          for (const arg of args) add(node, "_", arg);
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        const args = node.arguments;
        if (
          callee === "notFound" &&
          args[0] &&
          ts.isStringLiteralLike(args[0])
        ) {
          sites.push({
            where: `${relative(SRC, file)}`,
            code: "NOT_FOUND",
            template: `${args[0].text}不存在`,
          });
        } else if (
          (callee === "badRequest" || callee === "conflict") &&
          args[0]
        ) {
          const code =
            args[1] && ts.isStringLiteralLike(args[1])
              ? args[1].text
              : callee === "badRequest"
                ? "BAD_REQUEST"
                : "CONFLICT";
          add(node, code, args[0]);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ZOD_METHODS.has(node.expression.name.text)
        ) {
          for (const arg of args) {
            add(node, "_", arg);
            if (ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  prop.name.getText(sf) === "message"
                )
                  add(node, "_", prop.initializer);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

/** Fills placeholders with ASCII samples; conditional parts are also tried empty */
function samples(template: string): string[] {
  const has = /\{\d+\}/.test(template);
  if (!has) return [template];
  return [
    template.replace(/\{\d+\}/g, "abc"),
    template.replace(/\{\d+\}/g, ""),
    template.replace(/\{\d+\}/g, "42"),
  ];
}

const translates = (code: string, template: string): boolean =>
  samples(template).some((sample) => {
    const out = translateErrorMessage(code, sample, "en");
    return out !== sample && !CJK.test(out);
  });

describe("server error message catalog", () => {
  const sites = collectSites();

  it("finds the error throw sites (sanity check for the scanner)", () => {
    expect(sites.length).toBeGreaterThan(300);
  });

  it("every Chinese error message has an English translation (or is allowlisted)", () => {
    const missing = sites
      .filter((site) => !ALLOWLIST.has(`${site.code}|${site.template}`))
      .filter((site) => !translates(site.code, site.template))
      .map((site) => `${site.where} ${site.code} ${site.template}`);
    expect(missing).toEqual([]);
  });

  it("every code thrown with a Chinese message has a catalog entry", () => {
    const codes = new Set(
      sites
        .map((site) => site.code)
        .filter((code) => /^[A-Z][A-Z0-9_]*$/.test(code)),
    );
    const allowlistedCodes = new Set(
      [...ALLOWLIST].map((key) => key.split("|")[0]),
    );
    const missing = [...codes].filter(
      (code) => !(code in ERROR_CATALOG) && !allowlistedCodes.has(code),
    );
    expect(missing).toEqual([]);
  });

  it("catalog entries keep their placeholders and English entries contain no Chinese", () => {
    const bad: string[] = [];
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(",");
    for (const [code, entries] of Object.entries(ERROR_CATALOG)) {
      for (const [zh, en] of entries) {
        if (CJK.test(en)) bad.push(`${code}: ${en}`);
        if (names(zh) !== names(en))
          bad.push(`${code}: placeholders differ ${zh} / ${en}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("translates nested messages, nouns and lists", () => {
    expect(translateErrorMessage("NOT_FOUND", "客户不存在", "en")).toBe(
      "Customer not found",
    );
    expect(translateErrorMessage("FORBIDDEN", "没有权限：删除客户", "en")).toBe(
      "Permission denied: delete customers",
    );
    expect(
      translateErrorMessage("FORBIDDEN", "只能修改自己负责的订单", "en"),
    ).toBe("This order is owned by someone else; you can only modify your own");
    expect(
      translateErrorMessage(
        "EMAIL_SEND_FAILED",
        "发送失败：SMTP 连接失败：ECONNREFUSED",
        "en",
      ),
    ).toBe("Sending failed: SMTP connection failed: ECONNREFUSED");
    expect(
      translateErrorMessage(
        "CUSTOMER_HAS_RECORDS",
        "该客户名下有 2 个订单、1 条收款，不能删除。请先转移或处理这些记录。",
        "en",
      ),
    ).toBe(
      "This customer has 2 order(s), 1 payment(s) and cannot be deleted. Transfer or resolve those records first.",
    );
    expect(
      translateErrorMessage("INVALID_SCHEDULE", "cron 分字段不合法：x", "en"),
    ).toBe("Invalid cron minute field: x");
    expect(
      translateErrorMessage(
        "LOGIN_RATE_LIMITED",
        "尝试次数过多，请 5 分钟后再试",
        "en",
      ),
    ).toBe("Too many attempts; try again in 5 min");
  });

  it("uses explicit params over values extracted from the message", () => {
    expect(
      translateErrorMessage("ORDER_NUMBER_TAKEN", "订单号 A-1 已存在", "en", {
        0: "B-2",
      }),
    ).toBe("Order number B-2 already exists");
  });

  it("leaves zh, unknown and non-Chinese messages unchanged", () => {
    expect(translateErrorMessage("NOT_FOUND", "客户不存在", "zh")).toBe(
      "客户不存在",
    );
    expect(translateErrorMessage("WHATEVER", "一条没有登记的消息", "en")).toBe(
      "一条没有登记的消息",
    );
    expect(
      translateErrorMessage("UPSTREAM_ERROR", "Provider error: 500", "en"),
    ).toBe("Provider error: 500");
  });

  it("translates zod validation summaries part by part", () => {
    expect(
      translateValidationMessage(
        "参数校验失败（company：公司名不能为空；contacts.0.email：Invalid email）",
        "en",
      ),
    ).toBe(
      "Validation failed (company: Company name cannot be empty; contacts.0.email: Invalid email)",
    );
    expect(
      translateValidationMessage("参数校验失败（请求体：Invalid input）", "en"),
    ).toBe("Validation failed (body: Invalid input)");
    expect(translateValidationMessage("参数校验失败（a：b）", "zh")).toBeNull();
  });

  it("picks the language from X-Lulux-Lang, then Accept-Language", () => {
    expect(errorLangFrom({})).toBe("zh");
    expect(errorLangFrom({ "x-lulux-lang": "en" })).toBe("en");
    expect(
      errorLangFrom({ "x-lulux-lang": "zh-CN", "accept-language": "en-US" }),
    ).toBe("zh");
    expect(errorLangFrom({ "accept-language": "en-US,en;q=0.9" })).toBe("en");
    expect(
      errorLangFrom({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" }),
    ).toBe("zh");
    expect(errorLangFrom({ "accept-language": "zh;q=0.5, en;q=0.9" })).toBe(
      "en",
    );
  });
});

describe("error middleware translates by request language", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server?.close();
  });

  it("answers in Chinese by default and in English when asked", async () => {
    const zh = await server.request("GET", "/api/customers/nope");
    expect(zh.status).toBe(404);
    expect(zh.json.error).toEqual({ code: "NOT_FOUND", message: "客户不存在" });

    const en = await server.request("GET", "/api/customers/nope", {
      headers: { "X-Lulux-Lang": "en" },
    });
    expect(en.status).toBe(404);
    expect(en.json.error).toEqual({
      code: "NOT_FOUND",
      message: "Customer not found",
    });

    const accept = await server.request("GET", "/api/customers/nope", {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    expect(accept.json.error.message).toBe("Customer not found");
  });

  it("translates validation errors and unmatched routes", async () => {
    const res = await server.request("POST", "/api/customers", {
      body: { company: "" },
      headers: { "X-Lulux-Lang": "en" },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_ERROR");
    expect(res.json.error.message).toMatch(/^Validation failed \(/);
    expect(res.json.error.message).not.toMatch(CJK);

    const missing = await server.request("GET", "/api/definitely-not-a-route", {
      headers: { "X-Lulux-Lang": "en" },
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toBe("Endpoint not found");
  });

  it("translates the message and keeps structured details", async () => {
    const created = await server.request("POST", "/api/customers", {
      body: { company: "Pied Piper Trading Co., Ltd." },
    });
    expect(created.status, created.text).toBe(201);
    const dup = await server.request("POST", "/api/customers", {
      body: { company: "pied piper trading" },
      headers: { "X-Lulux-Lang": "en" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("CUSTOMER_DUPLICATE");
    expect(dup.json.error.message).toMatch(
      /^Possible duplicate of existing customer “Pied Piper Trading Co\., Ltd\.”/,
    );
    expect(dup.json.error.message).toContain("same company name");
    expect(dup.json.error.details.duplicates[0].company).toBe(
      "Pied Piper Trading Co., Ltd.",
    );
  });

  it("allows the language header in CORS preflight", async () => {
    const res = await server.request("OPTIONS", "/api/health", {
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "GET",
      },
      token: null,
    });
    if (res.status === 204)
      expect(String(res.headers["access-control-allow-headers"])).toContain(
        "X-Lulux-Lang",
      );
  });
});
