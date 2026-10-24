import { describe, expect, it } from 'vitest'
import {
  anthropicMessageFrom,
  AnthropicStreamEncoder,
  anthropicToCanonical,
} from '../src/services/gateway/anthropic.js'
import { geminiResponseFrom, GeminiStreamEncoder, geminiToCanonical } from '../src/services/gateway/gemini.js'
import { chatCompletionFrom, ChatStreamEncoder, chatToCanonical } from '../src/services/gateway/openai-chat.js'
import { responsesFrom, ResponsesStreamEncoder, responsesToCanonical } from '../src/services/gateway/responses.js'
import { estimateTokens, normalizeSchema, type StreamEvent } from '../src/services/gateway/types.js'

/** 解析 SSE 文本为 [{event, data}]（data 为 JSON 或 [DONE] 原文） */
function frames(text: string): Array<{ event: string | null; data: any }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null
      const raw = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      return { event, data: raw === '[DONE]' ? raw : JSON.parse(raw) }
    })
}

const toolCallEvent: StreamEvent = {
  type: 'tool_calls',
  calls: [{ id: 'call_9', name: 'lookup', arguments: '{"sku":"BV-25"}' }],
}

describe('Anthropic Messages → 规范请求', () => {
  it('system 块数组、tool_use / tool_result、thinking 降级、服务端工具跳过', () => {
    const request = anthropicToCanonical({
      model: 'claude-lulux-mock-mock-1',
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: '你是助手' }, { type: 'text', text: '简洁' }],
      thinking: { type: 'enabled', budget_tokens: 2000 },
      tools: [
        { name: 'lookup', description: '查价格', input_schema: { type: 'object', properties: { sku: { type: 'string' } } } },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      messages: [
        { role: 'user', content: '查价格' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一想', signature: 'sig' },
            { type: 'text', text: '我来查。' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { sku: 'BV-25' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'PRICE=42' }] },
            { type: 'text', text: '继续' },
          ],
        },
      ],
    })
    expect(request.system).toBe('你是助手\n简洁')
    expect(request.stream).toBe(true)
    expect(request.maxTokens).toBe(1024)
    expect(request.tools.map((tool) => tool.name)).toEqual(['lookup'])
    expect(request.turns).toEqual([
      { role: 'user', content: '查价格' },
      { role: 'assistant', content: '我来查。', toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: '{"sku":"BV-25"}' }] },
      { role: 'tool', content: 'PRICE=42', toolCallId: 'toolu_1' },
      { role: 'user', content: '继续' },
    ])
  })

  it('is_error 的 tool_result 带标记；图片用占位文本', () => {
    const request = anthropicToCanonical({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' },
            { type: 'image', source: { type: 'base64', data: 'xx' } },
          ],
        },
      ],
    })
    expect(request.turns[1]).toEqual({ role: 'tool', content: '[工具执行出错] boom', toolCallId: 't1' })
    expect(request.turns[2]!.content).toContain('图片')
  })
})

describe('规范流 → Anthropic SSE / Message', () => {
  it('文本增量 + 工具调用拼成合法事件序列，stop_reason=tool_use', () => {
    const encoder = new AnthropicStreamEncoder('claude-lulux-x', 12)
    const text =
      encoder.start() +
      encoder.push({ type: 'text', text: '我来' }) +
      encoder.push({ type: 'text', text: '查。' }) +
      encoder.push(toolCallEvent) +
      encoder.finish()
    const list = frames(text)
    expect(list.map((frame) => frame.event)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(list[0]!.data.message).toMatchObject({ role: 'assistant', model: 'claude-lulux-x', usage: { input_tokens: 12 } })
    expect(list[6]!.data).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'call_9', name: 'lookup' } })
    expect(list[7]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"sku":"BV-25"}' })
    expect(list[9]!.data.delta.stop_reason).toBe('tool_use')
    // 客户端拼接：文本增量合起来就是完整文本
    const joined = list
      .filter((frame) => frame.data?.delta?.type === 'text_delta')
      .map((frame) => frame.data.delta.text)
      .join('')
    expect(joined).toBe('我来查。')
  })

  it('纯文本 stop_reason=end_turn；非流式 Message 含 tool_use 块', () => {
    const encoder = new AnthropicStreamEncoder('m', 1)
    const list = frames(encoder.start() + encoder.push({ type: 'text', text: 'hi' }) + encoder.finish())
    expect(list.find((frame) => frame.event === 'message_delta')!.data.delta.stop_reason).toBe('end_turn')

    const message = anthropicMessageFrom('m', 5, [{ type: 'text', text: '好的' }, toolCallEvent])
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'call_9', name: 'lookup', input: { sku: 'BV-25' } },
      ],
    })
  })
})

describe('OpenAI Responses ⇄ 规范', () => {
  it('instructions / developer / function_call 往返 / custom 工具', () => {
    const request = responsesToCanonical({
      model: 'gpt-x',
      instructions: '系统说明',
      stream: true,
      tools: [
        { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
        { type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar' } },
        { type: 'web_search' },
      ],
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '开发者说明' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列出文件' }] },
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' },
        { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
      ],
    })
    expect(request.system).toBe('系统说明\n\n开发者说明')
    expect(request.tools.map((tool) => tool.name)).toEqual(['shell', 'apply_patch'])
    expect([...request.customTools]).toEqual(['apply_patch'])
    expect(request.turns).toEqual([
      { role: 'user', content: '列出文件' },
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' }] },
      { role: 'tool', content: 'a.txt', toolCallId: 'c1' },
    ])
  })

  it('字符串 input 视为用户消息', () => {
    expect(responsesToCanonical({ input: 'hi' }).turns).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('流式事件：created → 文本 → function_call → completed（带 usage）', () => {
    const encoder = new ResponsesStreamEncoder('gpt-x', 20)
    const list = frames(
      encoder.start() + encoder.push({ type: 'text', text: '你' }) + encoder.push({ type: 'text', text: '好' }) + encoder.push(toolCallEvent) + encoder.finish(),
    )
    expect(list.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ])
    // data.type 与 event 名一致，sequence_number 递增
    expect(list.every((frame) => frame.data.type === frame.event)).toBe(true)
    expect(list.map((frame) => frame.data.sequence_number)).toEqual(list.map((_, index) => index))
    expect(list[6]!.data.text).toBe('你好')
    const completed = list[list.length - 1]!.data.response
    expect(completed.status).toBe('completed')
    expect(completed.usage).toMatchObject({ input_tokens: 20, input_tokens_details: { cached_tokens: 0 } })
    expect(completed.output).toEqual([
      { id: expect.any(String), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] },
      { id: expect.any(String), type: 'function_call', status: 'completed', call_id: 'call_9', name: 'lookup', arguments: '{"sku":"BV-25"}' },
    ])
  })

  it('custom 工具调用回成 custom_tool_call；非流式 response 对象', () => {
    const response = responsesFrom('gpt-x', 3, [{ type: 'tool_calls', calls: [{ id: 'c2', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' }] }], new Set(['apply_patch']))
    expect(response.output).toEqual([
      { id: expect.any(String), type: 'custom_tool_call', status: 'completed', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
    ])
  })
})

describe('OpenAI Chat Completions ⇄ 规范', () => {
  it('请求转换：system/developer、多段内容、tool_calls、tool', () => {
    const request = chatToCanonical({
      model: 'm',
      stream: true,
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'x1', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    })
    expect(request.system).toBe('S')
    expect(request.turns).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'f', arguments: '{}' }] },
      { role: 'tool', content: 'ok', toolCallId: 'x1' },
    ])
    expect(request.tools[0]!.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('流式 chunk：首帧带 role，工具调用 finish_reason=tool_calls，usage 帧与 [DONE]', () => {
    const encoder = new ChatStreamEncoder('m', 7, true)
    const list = frames(encoder.push({ type: 'text', text: 'hi' }) + encoder.push(toolCallEvent) + encoder.finish())
    expect(list[0]!.data.choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
    expect(list[1]!.data.choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"sku":"BV-25"}' } })
    expect(list[2]!.data.choices[0].finish_reason).toBe('tool_calls')
    expect(list[3]!.data.usage.prompt_tokens).toBe(7)
    expect(list[4]!.data).toBe('[DONE]')
    expect(chatCompletionFrom('m', 1, [{ type: 'text', text: 'x' }])).toMatchObject({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  })
})

describe('Gemini ⇄ 规范', () => {
  it('functionCall 无 id 时按名字与 functionResponse 配对；大写 type 规范化', () => {
    const request = geminiToCanonical(
      {
        systemInstruction: { parts: [{ text: 'SYS' }] },
        contents: [
          { role: 'user', parts: [{ text: '读文件' }] },
          { role: 'model', parts: [{ text: '好', thought: true }, { functionCall: { name: 'read_file', args: { path: 'a' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'AAA' } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }],
        generationConfig: { maxOutputTokens: 100 },
      },
      'gemini-2.5-pro',
      true,
    )
    expect(request.system).toBe('SYS')
    const call = request.turns[1]!.toolCalls![0]!
    expect(request.turns[1]!.content).toBe('')
    expect(call).toMatchObject({ name: 'read_file', arguments: '{"path":"a"}' })
    expect(request.turns[2]).toMatchObject({ role: 'tool', toolCallId: call.id, content: '{"output":"AAA"}' })
    expect(request.tools[0]!.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
    expect(request.maxTokens).toBe(100)
  })

  it('流式帧与非流式响应', () => {
    const encoder = new GeminiStreamEncoder('gemini-2.5-pro', 4)
    const list = frames(encoder.push({ type: 'text', text: 'A' }) + encoder.push(toolCallEvent) + encoder.finish())
    expect(list[0]!.data.candidates[0].content).toEqual({ role: 'model', parts: [{ text: 'A' }] })
    expect(list[1]!.data.candidates[0].content.parts[0]).toEqual({ functionCall: { id: 'call_9', name: 'lookup', args: { sku: 'BV-25' } } })
    expect(list[2]!.data.candidates[0].finishReason).toBe('STOP')
    expect(list[2]!.data.usageMetadata.promptTokenCount).toBe(4)
    const response = geminiResponseFrom('g', 1, [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }])
    expect((response.candidates as any)[0].content.parts).toEqual([{ text: 'xy' }])
  })
})

describe('工具函数', () => {
  it('estimateTokens 对中英文都给出正数估计', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('你好')).toBe(2)
  })
  it('normalizeSchema 去掉 $schema、补 properties', () => {
    expect(normalizeSchema({ $schema: 'x', type: 'object' })).toEqual({ type: 'object', properties: {} })
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })
})
