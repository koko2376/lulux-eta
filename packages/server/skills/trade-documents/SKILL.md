---
name: trade-documents
description: 生成外贸单据：形式发票 PI、商业发票 CI、装箱单 PL（PDF，英文格式，含金额英文大写、唛头、银行信息、毛净重体积合计），并提供单据一致性检查清单（尤其信用证项下单证相符）。用户要“做 PI/发票/装箱单”时使用。
license: BSL-1.1
metadata:
  author: LULUX ETA
  version: 1.0.0
  category: trade
  keywords: [PI, 形式发票, proforma invoice, CI, 商业发票, commercial invoice, PL, 装箱单, packing list, 单据, 制单, 唛头]
  requires:
    tools: [run_skill_script, workspace_write, get_customer, search_customers]
---

# PI / CI / PL 生成

## 输入准备
1. 从系统取数据：客户（`search_customers` → `get_customer`：公司全称、地址、联系人）；报价单（会话绑定的报价或用户指定的报价）中的品名、规格、数量、单价、术语、付款方式、交期。
2. 向用户确认缺失项：我方公司抬头与银行信息（**不要编造银行账号**，没有就留空让用户填）、单据号、唛头、包装数据（每箱数量、毛/净重、外箱尺寸）、装运港/目的港、HS 编码。
3. 按 `templates/document-input.example.json` 的结构写 JSON，用 `workspace_write` 存为 `doc-input.json`。

## 生成
`run_skill_script`：`skill: "trade-documents"`，`script: "trade_docs.cjs"`，`args: ["doc-input.json", "--type", "ALL"]`（`PI`/`CI`/`PL`/`ALL`，默认输出到工作区 `documents/`）。生成的 PDF 会出现在产物面板，可下载。

## 三种单据的区别
| 单据 | 用途 | 关键内容 |
| --- | --- | --- |
| PI 形式发票 | 成交前/订单确认、客户申请付款或进口许可 | 有效期、交期、付款方式、银行信息 |
| CI 商业发票 | 出货后结汇、客户清关 | 发票号与日期、实际出货数量金额、原产地、L/C 号、唛头 |
| PL 装箱单 | 清关、提货点数 | 每项箱数、毛净重、尺寸、体积、合计；与 CI 数量一致 |

## 单据一致性检查清单（出单前逐项核对）
- [ ] 买卖双方名称地址与合同/L/C 完全一致（含标点、Co., Ltd. 写法）。
- [ ] 品名描述：L/C 项下 CI 品名须与 L/C 46A/45A **逐字一致**，其他单据可用不矛盾的统称。
- [ ] 数量、单价、总额：CI 金额不超过 L/C 金额；溢短装是否在允许范围（如 ±5%）。
- [ ] 贸易术语与地点（FOB Ningbo / CIF Hamburg, Incoterms 2020）与合同一致。
- [ ] PL 的箱数、毛净重、体积与 CI 数量、提单、报关单一致；SAY TOTAL 大写正确。
- [ ] 唛头在 CI、PL、提单上一致。
- [ ] 日期逻辑：发票日期 ≤ 提单日期；单据在 L/C 交单期内（通常装运后 21 天且不超过有效期）。
- [ ] 原产地、HS 编码与报关单一致；需要产地证（CO / FORM E / FORM A 等）时提醒用户另行申请。
- [ ] 银行信息由用户核对（防止被篡改的诈骗风险：客户如要求改收款账户须电话核实）。

## 注意
- 脚本生成英文单据；中文内容会自动使用系统中文字体。
- 单据是商业文件，生成后提醒用户人工复核并盖章签字。
