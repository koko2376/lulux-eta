---
name: word-docx
description: 生成 Word 文档（.docx）：把 Markdown 内容（标题、段落、列表、表格、引用、代码、分页）转换为排版规范的 Word 文件，可加标题、目录、页眉页脚与页码，产物可在产物面板下载。用户要“写成 Word”“导出 docx”“做一份合同/方案/报告文档”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: office
  keywords: [Word, docx, 文档, 导出Word, 生成文档, 报告, 方案, 合同文档]
  requires:
    tools: [workspace_write, run_skill_script]
    npm: [docx@9]
---

# Word 文档生成

## 步骤
1. **先写内容**：按用户需求写好 Markdown（标题层级清楚：`#` 文档大标题只用一次或用 `--title`，正文从 `##` 开始）。正式文档建议结构：标题 → 摘要/背景 → 正文分节 → 结论/下一步 → 附录。
2. `workspace_write` 保存为 `.md`（如 `方案.md`）。
3. `run_skill_script`：`skill: "word-docx"`，`script: "make_docx.cjs"`，`args: ["方案.md", "方案.docx", "--title", "LED 欧洲市场开拓方案", "--toc", "--header", "公司名", "--footer", "内部资料"]`。
   - 可选参数：`--author`、`--font`（默认 Microsoft YaHei；英文文档可用 `Calibri`）、`--toc`（插入目录，Word 打开时提示更新域）。
   - 首次运行会自动安装 npm 依赖 `docx`（需要联网，之后离线可用）。
4. 生成的 `.docx` 会出现在产物面板，告诉用户文件名并简述结构。

## 支持的 Markdown
| 语法 | Word 效果 |
| --- | --- |
| `#`–`######` | 标题 1–6（可进目录） |
| `**粗体**`、`*斜体*`、`` `代码` ``、`[文字](https://…)` | 对应格式 / 超链接 |
| `- 项目`、`1. 项目`（缩进 2 空格为二级） | 项目符号 / 编号列表 |
| `| 表头 |` + `| --- |` | 带边框表格（表头底色，`---:` 右对齐） |
| `> 引用` | 缩进斜体引用 |
| ```` ``` ```` | 等宽代码块 |
| `---` | 分隔线 |
| `<!-- pagebreak -->` | 分页 |

## 写作与排版建议
- 中文正式文档：一级标题用“一、二、三”，二级用“（一）（二）”，可直接写在标题文字里。
- 合同/条款类：编号用 `1.` `1.1` 写在文字中，避免自动编号与条款号冲突；涉及法律效力的内容提醒用户请法务审核。
- 表格列不宜超过 6 列；长表格拆分或改用 excel-xlsx 技能。
- 需要图表：先用 data-charts 技能生成 SVG/数据，再在文档中描述或作为附件（当前脚本不嵌入图片）。

## 常见问题
- 依赖安装失败：检查网络或在设置中更换 npm 源（kernelRegistry）。
- 用户要编辑已有 .docx：当前脚本只负责生成；可让用户提供 Markdown/文本内容，或用 pdf-tools 提取 PDF 文本后重新生成。
