import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle, parseBatchImageCallArguments } from './agentApi'

describe('parseBatchImageCallArguments', () => {
  it('trims ids and prompts, fills missing ids, and skips empty prompts', () => {
    expect(parseBatchImageCallArguments(JSON.stringify({ images: [
      { id: ' hero ', prompt: ' first prompt ' },
      { id: '   ', prompt: 'blank id' },
      { prompt: 'missing id' },
      { id: 'skipped', prompt: '   ' },
    ] }))).toEqual([
      { id: 'hero', prompt: 'first prompt' },
      { id: 'image_2', prompt: 'blank id' },
      { id: 'image_3', prompt: 'missing id' },
    ])
  })

  it('makes duplicate and colliding ids deterministically unique', () => {
    const args = JSON.stringify({ images: [
      { id: 'same', prompt: 'one' },
      { id: ' same ', prompt: 'two' },
      { id: 'same_2', prompt: 'three' },
      { id: 'same', prompt: 'four' },
    ] })

    expect(parseBatchImageCallArguments(args)).toEqual([
      { id: 'same', prompt: 'one' },
      { id: 'same_2', prompt: 'two' },
      { id: 'same_2_2', prompt: 'three' },
      { id: 'same_3', prompt: 'four' },
    ])
    expect(parseBatchImageCallArguments(args)).toEqual(parseBatchImageCallArguments(args))
  })
})

describe('callBatchImageSingle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('图片保存后连接断开仍返回成功，且不会再次请求或重复保存', async () => {
    let readCount = 0
    const imageEvent = 'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"saved-image","result":"c2F2ZWQ="}}\n\n'
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount++ < 2) controller.enqueue(new TextEncoder().encode(imageEvent))
        else controller.error(new Error('图片已完成后的连接中断'))
      },
    }, { highWaterMark: 0 })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
    const onImageToolCompleted = vi.fn()

    const result = await callBatchImageSingle({
      profile: createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', streamImages: true }),
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: '画猫',
      referenceImageDataUrls: [],
      onImageToolCompleted,
    })

    expect(result).toMatchObject({ image: { dataUrl: 'data:image/png;base64,c2F2ZWQ=' }, error: null })
    expect(onImageToolCompleted).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('图片保存失败仍明确返回失败，不能把收到像素当作已保存', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"c2F2ZWQ="}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))

    const result = await callBatchImageSingle({
      profile: createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', streamImages: true }),
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: '画猫',
      referenceImageDataUrls: [],
      onImageToolCompleted: async () => { throw new Error('图片未能写入磁盘') },
    })

    expect(result).toMatchObject({ image: null, error: '图片未能写入磁盘' })
  })

  it('图片完成前断流保留错误，不自动发起新的计费请求', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('连接中断')) } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
    const result = await callBatchImageSingle({
      profile: createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', streamImages: true }),
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: '画猫',
      referenceImageDataUrls: [],
    })

    expect(result).toMatchObject({ image: null, error: '连接中断' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports the image tool error without a misleading streaming hint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Tool choice 'required' must be specified with 'tools' parameter." },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    const result = await callBatchImageSingle({
      profile: createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', streamImages: true }),
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: 'prompt',
      referenceImageDataUrls: [],
    })

    expect(result).toMatchObject({
      batchItemId: 'image_1',
      image: null,
      error: "Tool choice 'required' must be specified with 'tools' parameter.\n提示：当前使用的 API 可能未正确转发图像生成工具，请尝试更换支持该工具的接口或模型。",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('callAgentResponsesApi', () => {
  it('手动选择五张时只提供五项批量图像工具；数量用完后不再提供生图工具', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ output: [] }), { headers: { 'Content-Type': 'application/json' } }))
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses', apiKey: 'mock-text-key' })
    const settings = { ...DEFAULT_SETTINGS, agentImageCount: 5 }
    await callAgentResponsesApi({ settings, profile, params: DEFAULT_PARAMS, input: '画五张不同的图' })
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(first.tools).toHaveLength(1)
    expect(first.tools[0]).toMatchObject({ name: 'generate_image_batch', parameters: { properties: { images: { minItems: 5, maxItems: 5 } } } })
    expect(first.instructions).toContain('五个独立条目和五个独立图片文件')
    expect(first.instructions).toContain('用户只聊天或询问问题时正常回复文字')
    await callAgentResponsesApi({ settings, profile, params: DEFAULT_PARAMS, input: '继续', remainingImageCount: 0 })
    const finished = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(finished.tools).toBeUndefined()
    expect(finished.instructions).toContain('不得自动重试、补图或追加图片请求')
    await callAgentResponsesApi({ settings: { ...settings, agentImageCount: 1 }, profile, params: DEFAULT_PARAMS, input: '生成一张图片' })
    const single = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(single.tools[0]).toMatchObject({ name: 'generate_image_batch', parameters: { properties: { images: { minItems: 1, maxItems: 1 } } } })
    expect(single.tools[0].description).toContain('数量为 1 时同样适用')
    expect(single.tools[0].description).not.toContain('2+ remaining')
  })

  it('混合模式使用独立文本 Key 发送历史文字和参考图，并接收纯文本回复', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'text-response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '建议保留角色的白色爪子。' }] }],
    }), { headers: { 'Content-Type': 'application/json' } }))
    const profile = createDefaultOpenAIProfile({ id: 'text', baseUrl: 'https://text.example.com/v1', apiKey: 'mock-text-key', apiMode: 'responses', model: 'text-selected', streamImages: false })
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: '这是角色参考图' }, { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '我看到了角色参考图。' }] },
      { role: 'user', content: [{ type: 'input_text', text: '先用文字建议需要保留的特征' }] },
    ]
    const result = await callAgentResponsesApi({ settings: { ...DEFAULT_SETTINGS, agentApiConfigMode: 'hybrid' }, profile, params: DEFAULT_PARAMS, input })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://text.example.com/v1/responses')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer mock-text-key' })
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('text-selected')
    expect(body.input).toEqual(input)
    expect(body.tools.some((tool: { type: string }) => tool.type === 'image_generation')).toBe(false)
    expect(result.text).toBe('建议保留角色的白色爪子。')
    expect(result.images).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('收到响应头后流式停顿时仍按超时中止，并给出中文原因', async () => {
    // 与浏览器一致：信号中止后，读取中的响应体以 signal.reason 报错
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit).signal!
      const body = new ReadableStream<Uint8Array>({
        start: (ctrl) => {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'))
          signal.addEventListener('abort', () => ctrl.error(signal.reason))
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', streamImages: true, timeout: 0.05 })

    const err = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: 'prompt',
    }).catch((e) => e)

    expect(err).toMatchObject({ name: 'AbortError', message: '请求超时：超过 0.05 秒仍未完成，请稍后重试或提高超时时间。' })
  })

  it('streams Agent text and requests configured partial images', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"image_generation_call","id":"ig_1","result":"ZmluYWw=","size":"1024x1024"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
      streamPartialImages: 2,
      reasoningEffort: 'xhigh',
      imageGenerationModel: 'gpt-image-2.5-flare',
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      onTextDelta: (delta) => textDeltas.push(delta),
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBe(true)
    expect(body.reasoning).toEqual({ effort: 'xhigh' })
    expect(body.tools[0].model).toBe('gpt-image-2.5-flare')
    expect(body.tools[0].partial_images).toBe(2)
    expect(textDeltas).toEqual(['Hel', 'lo'])
    expect(result).toMatchObject({
      responseId: 'resp_1',
      text: 'Hello',
      images: [{ toolCallId: 'ig_1', dataUrl: 'data:image/png;base64,ZmluYWw=' }],
    })
  })

  it('reports failed image output item without aborting the ongoing stream', async () => {
    const streamBody = [
      'data: {"type":"response.output_item.added","item":{"id":"ig_fail","type":"image_generation_call","status":"in_progress"},"output_index":0}',
      '',
      'data: {"type":"response.output_item.done","item":{"id":"ig_fail","type":"image_generation_call","status":"failed","error":{"message":"safety rejected"}},"output_index":0}',
      '',
      'data: {"type":"response.output_text.delta","delta":"已跳过失败图片"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"id":"ig_fail","type":"image_generation_call","status":"failed","error":{"message":"safety rejected"}},{"type":"message","content":[{"type":"output_text","text":"已跳过失败图片"}]}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const failures: Array<{ toolCallId: string; error: string }> = []
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      onImageToolFailed: (event) => {
        failures.push(event)
      },
    })

    expect(failures).toEqual([{ toolCallId: 'ig_fail', error: 'safety rejected' }])
    expect(result).toMatchObject({
      responseId: 'resp_1',
      text: '已跳过失败图片',
      images: [],
    })
    expect(result.rawResponsePayload).toContain('resp_1')
  })

  it('passes mask data to the Agent image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'edit' }] }],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools[0].input_image_mask).toEqual({ image_url: 'data:image/png;base64,bWFzaw==' })
  })

  it('requires resolution in Agent prompts and omits the Codex CLI size parameter', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      codexCli: true,
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      input: 'prompt',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools[0].size).toBeUndefined()
    expect(body.instructions).toContain('Start every image prompt with exactly "Generate at 1024x1024 resolution." followed by a space.')
  })

  it('extracts image_generation results from base64 object fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        id: 'ig_base64',
        result: { base64: 'ZmlsZQ==' },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    expect(result.images).toEqual([{
      toolCallId: 'ig_base64',
      dataUrl: 'data:image/png;base64,ZmlsZQ==',
      actualParams: {},
    }])
  })

  it('stops reading a stream when the caller aborts after output starts', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamBody))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const abortController = new AbortController()
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
    })

    await expect(callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      signal: abortController.signal,
      onTextDelta: (delta) => {
        textDeltas.push(delta)
        abortController.abort()
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(textDeltas).toEqual(['Hel'])
  })

  it('generates a short conversation title without image tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '<title>生成猫咪头像</title>' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
      reasoningEffort: 'max',
    })

    const title = await callAgentConversationTitleApi({
      settings: DEFAULT_SETTINGS,
      profile,
      prompt: '帮我生成一张橘猫头像，要赛博朋克风格',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.instructions).toContain('<title>short title</title>')
    expect(body.reasoning).toEqual({ effort: 'max' })
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.stream).toBeUndefined()
    expect(body.input[0].content[0].text).toContain('帮我生成一张橘猫头像，要赛博朋克风格')
    expect(title).toBe('生成猫咪头像')
  })

  it('requests web search and applies citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_search',
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'OpenAI web search docs' },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'See OpenAI docs.',
            annotations: [{
              type: 'url_citation',
              start_index: 4,
              end_index: 15,
              url: 'https://platform.openai.com/docs',
              title: 'OpenAI Docs',
            }],
          }],
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: { ...DEFAULT_SETTINGS, agentWebSearch: true },
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools).toEqual(expect.arrayContaining([{ type: 'web_search' }]))
    expect(result.text).toBe('See [OpenAI docs](https://platform.openai.com/docs).')
    expect(result.outputItems?.[0]).toMatchObject({ type: 'web_search_call', status: 'completed' })
  })

  it('injects configurable math formatting instructions', async () => {
    const createResponse = () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => createResponse())
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    let body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.instructions).toContain('## Math formatting')
    expect(body.instructions).toContain('Use `$...$` for inline formulas.')

    await callAgentResponsesApi({
      settings: { ...DEFAULT_SETTINGS, agentMathFormattingPrompt: false },
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))
    expect(body.instructions).not.toContain('## Math formatting')
  })

  it("does not duplicate the assistant message item when response.completed lacks an item id", async () => {
    // `response.completed` can repeat the streamed item without id; it should merge, not append.
    const itemId = "msg_abc123"
    const streamBody = [
      `data: {"type":"response.created","response":{"id":"resp_1","output":[]}}`,
      ``,
      `data: {"type":"response.output_item.added","item":{"id":"${itemId}","type":"message","status":"in_progress","content":[],"role":"assistant"}}`,
      ``,
      `data: {"type":"response.output_text.delta","delta":"hi","item_id":"${itemId}"}`,
      ``,
      `data: {"type":"response.output_text.delta","delta":"!","item_id":"${itemId}"}`,
      ``,
      `data: {"type":"response.output_item.done","item":{"id":"${itemId}","type":"message","status":"completed","content":[{"type":"output_text","text":"hi!"}],"role":"assistant"}}`,
      ``,
      `data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi!"}]}]}}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const outputItemSnapshots: number[] = []
    const profile = createDefaultOpenAIProfile({
      apiKey: "test-key",
      apiMode: "responses",
      streamImages: true,
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      onOutputItems: (items) => outputItemSnapshots.push(items.length),
    })

    const messageItems = (result.outputItems ?? []).filter((item) => item.type === "message")
    expect(messageItems).toHaveLength(1)
    expect(result.text).toBe("hi!")
    expect(outputItemSnapshots[outputItemSnapshots.length - 1]).toBe(1)
  })
})
