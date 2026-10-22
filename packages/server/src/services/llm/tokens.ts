import type { ChatTurn, ToolDefinition } from "../../types.js";
import { estimateImageTokens } from "./images.js";

/**
 * token 启发式估算（不依赖分词器）：ASCII 约 4 字符 1 token，CJK 等宽字符约 1 字 1 token。
 * 不同 Provider 分词差异很大，估算只用于预算判断，统一乘 1.1 的保守系数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii += 1;
    else if (code >= 0xdc00 && code <= 0xdfff)
      continue; // 代理对后半
    else wide += 1;
  }
  return Math.ceil((ascii / 4 + wide) * 1.1);
}

/** 每条消息的格式开销 */
const PER_TURN = 4;

export function estimateTurn(turn: ChatTurn): number {
  let total = PER_TURN + estimateTokens(turn.content);
  for (const call of turn.toolCalls ?? [])
    total += 8 + estimateTokens(call.name) + estimateTokens(call.arguments);
  if (turn.reasoningBlocks)
    for (const block of turn.reasoningBlocks)
      total += estimateTokens(
        block.type === "thinking" ? block.thinking : block.data,
      );
  if (turn.images)
    for (const image of turn.images) total += estimateImageTokens(image);
  return total;
}

export function estimateTurns(turns: ChatTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTurn(turn), 0) + 3;
}

export function estimateTools(tools: ToolDefinition[] | undefined): number {
  if (!tools?.length) return 0;
  return tools.reduce(
    (sum, tool) =>
      sum +
      10 +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.inputSchema)),
    0,
  );
}
