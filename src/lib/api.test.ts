import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_IMAGES_MODEL, DEFAULT_SETTINGS, getCustomProviderDefinition, normalizeSettings } from './apiProfiles'
import { normalizePersistedState } from './persistedState'
import { callImageApi } from './api'
import { callBatchImageSingle } from './agentApi'
import { maybeAppendImageToolDroppedHint, maybeAppendStreamingHint } from './imageApiShared'
import { getCustomQueuedImageResult } from './openaiCompatibleImageApi'

describe('API error hints', () => {
  it.each([false, true])('uses the transparent background hint when streaming is %s', (streamImages) => {
    const message = 'Transparent background is not supported for this model.'

    expect(maybeAppendStreamingHint(message, 400, streamImages)).toBe(
      `${message}\n提示：当前使用的 API 不支持为该模型使用原生透明背景，请将「透明背景实现方式」切换为「本地后处理」。`,
    )
  })

  it('leaves other tool choice errors unchanged', () => {
    const message = 'The combination of tool_choice and tools is not supported.'
    expect(maybeAppendImageToolDroppedHint(message)).toBe(message)
  })
})

describe('callImageApi', () => {
  it('画廊多批和对话单图共用两个请求名额', async () => {
    let active = 0
    let peak = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      const payload = String(url).endsWith('/responses')
        ? { output: [{ type: 'image_generation_call', id: 'image', result: 'aW1hZ2U=' }] }
        : { data: [{ b64_json: 'aW1hZ2U=' }] }
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    })
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'mock-key', streamImages: false }
    const options = { settings, prompt: '三张独立作品', params: { ...DEFAULT_PARAMS, n: 3 }, inputImageDataUrls: [] }
    const results = await Promise.all([
      callImageApi(options), callImageApi(options),
      callBatchImageSingle({ profile: createDefaultOpenAIProfile({ apiKey: 'mock-key', apiMode: 'responses' }), params: DEFAULT_PARAMS, batchItemId: 'agent-image', prompt: '一张图', referenceImageDataUrls: [] }),
    ])
    expect(peak).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(results[0].images).toHaveLength(3)
    expect(results[1].images).toHaveLength(3)
    expect(results[2].image).not.toBeNull()
  })

  it.each([4, 5])('普通 Images 接口逐张生成 %s 张独立图片，保留 high 和序号', async (count) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: `image-${fetchMock.mock.calls.length}` }],
    }), { headers: { 'Content-Type': 'application/json' } }))
    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'mock-image-key', codexCli: false, streamImages: false },
      prompt: '生成五张圣诞纹样：雪人、姜饼人、绿色挂饰、驯鹿、雪花',
      params: { ...DEFAULT_PARAMS, quality: 'high', n: count },
      inputImageDataUrls: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(count)
    for (const [index, [url, init]] of fetchMock.mock.calls.entries()) {
      expect(String(url)).toContain('/images/generations')
      const body = JSON.parse(String(init?.body))
      expect(body.n).toBe(1)
      expect(body.quality).toBe('high')
      expect(body.prompt).toContain(`第 ${index + 1} 张，共 ${count} 张`)
      expect(body.prompt).toContain('只生成一张独立、完整')
    }
    expect(result.images).toHaveLength(count)
    expect(new Set(result.images).size).toBe(count)
  })

  it('逐张图生图保留同一组参考图，各请求只修改一张作品', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith('data:')) return originalFetch(url, init)
      return new Response(JSON.stringify({ data: [{ b64_json: 'image' }] }), { headers: { 'Content-Type': 'application/json' } })
    })
    await callImageApi({ settings: { ...DEFAULT_SETTINGS, apiKey: 'mock-key' }, prompt: '生成五款参考图变体', params: { ...DEFAULT_PARAMS, n: 5 }, inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='] })
    const requests = fetchMock.mock.calls.filter(([, init]) => init?.body instanceof FormData)
    expect(requests).toHaveLength(5)
    for (const [index, [url, init]] of requests.entries()) {
      expect(String(url)).toContain('/images/edits')
      const body = init?.body as FormData
      expect(body.get('n')).toBe('1')
      expect(body.getAll('image[]')).toHaveLength(1)
      expect(String(body.get('prompt'))).toContain(`第 ${index + 1} 张，共 5 张`)
    }
  })

  it('图生图携带全部参考图、当前图像 Key 和 high 参数发送到编辑接口', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith('data:')) return originalFetch(url, init)
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { headers: { 'Content-Type': 'application/json' } })
    })
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://image.example.com/v1', apiKey: 'mock-image-key', model: 'image-selected', streamImages: false, codexCli: false })
    await callImageApi({
      settings: normalizeSettings({ profiles: [profile], activeProfileId: profile.id }),
      prompt: '保留两张参考图的角色，改成水彩风格',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2Ux', 'data:image/png;base64,aW1hZ2Uy'],
    })
    const [url, init] = fetchMock.mock.calls.find(([, request]) => request?.body instanceof FormData)!
    expect(url).toBe('https://image.example.com/v1/images/edits')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer mock-image-key' })
    const body = init?.body as FormData
    expect(body.get('model')).toBe('image-selected')
    expect(body.get('quality')).toBe('high')
    expect(body.getAll('image[]')).toHaveLength(2)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it.each([false, true])(
    'adds the prompt rewrite guard on Responses API when Codex CLI mode is %s',
    async (codexCli) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'aW1hZ2U=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

      await callImageApi({
        settings: {
          ...DEFAULT_SETTINGS,
          apiKey: 'test-key',
          apiMode: 'responses',
          codexCli,
          profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, reasoningEffort: 'high' })),
        },
        prompt: 'prompt',
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      })

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.input).toBe('Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:\nprompt')
      expect(body.reasoning).toEqual({ effort: 'high' })
    },
  )

  it('does not add the prompt rewrite guard on Responses API when prompt rewrite is allowed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        result: 'aW1hZ2U=',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses', codexCli: true, allowPromptRewrite: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.input).toBe('prompt')
  })

  it('sends the selected GPT Image 2.5 model and max quality to the Responses image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiMode: 'responses' as const,
          imageGenerationModel: 'gpt-image-2.5-flare',
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, quality: 'max' },
      inputImageDataUrls: [],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2.5-flare',
      quality: 'max',
    })
  })

  it.each([undefined, '', 'custom-image-model', DEFAULT_IMAGES_MODEL])('sends the restored Responses tool model %s without autofilling', async (imageGenerationModel) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const profile = imageGenerationModel === DEFAULT_IMAGES_MODEL
      ? createDefaultOpenAIProfile({ apiMode: 'responses', apiKey: 'test-key', streamImages: false })
      : { apiMode: 'responses', apiKey: 'test-key', model: 'legacy-text-model', streamImages: false, ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }) }
    const restored = normalizePersistedState({ settings: { profiles: [profile] } }, {
      settings: DEFAULT_SETTINGS,
      params: DEFAULT_PARAMS,
      dismissedCodexCliPrompts: [],
      agentConversations: [],
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
    })!

    await callImageApi({
      settings: restored.state.settings,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    if (imageGenerationModel) expect(body.tools[0].model).toBe(imageGenerationModel)
    else expect(body.tools[0]).not.toHaveProperty('model')
  })

  it('sends a GPT Image 2.5 model and xhigh quality to the Images API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
      quality: 'xhigh',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        model: 'gpt-image-2.5-sunburst',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          model: 'gpt-image-2.5-sunburst',
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, quality: 'xhigh' },
      inputImageDataUrls: [],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      quality: 'xhigh',
    })
    expect(result.actualParams).toMatchObject({ quality: 'xhigh' })
  })

  it.each([false, true])('explains the image tool dropped error without retrying when streaming is %s', async (streamImages) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Tool choice 'required' must be specified with 'tools' parameter." },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, apiMode: 'responses' as const, streamImages })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow(/^Tool choice 'required' must be specified with 'tools' parameter\.\n提示：当前使用的 API 可能未正确转发图像生成工具，请尝试更换支持该工具的接口或模型。$/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).tool_choice).toBe('required')
  })

  it('keeps the original Responses error when the relay reports an unrelated failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model not found' },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, apiMode: 'responses' as const })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow('model not found')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not add the prompt rewrite guard on Codex CLI Images API when prompt rewrite is allowed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true, allowPromptRewrite: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.prompt).toBe('prompt')
  })

  it('requests a transparent background from the Images API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'webp', transparent_output: true },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.background).toBe('transparent')
    expect(body.output_format).toBe('webp')
  })

  it('requests a transparent background from the Images edit API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, transparent_output: true },
      nativeTransparentBackground: true,
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })

    const [, init] = fetchMock.mock.calls.find(([, request]) => (request as RequestInit | undefined)?.body instanceof FormData)!
    const body = (init as RequestInit).body as FormData
    expect(body.get('background')).toBe('transparent')
  })

  it('requests a transparent background from the Responses API image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, transparent_output: true },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools[0].background).toBe('transparent')
  })

  it('uses prompt engineering instead of the size parameter in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true, allowPromptRewrite: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.size).toBeUndefined()
    expect(body.prompt).toBe('Generate at 1024x1024 resolution. prompt')
  })

  it('does not add a size hint for auto in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true, allowPromptRewrite: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: 'auto' },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.size).toBeUndefined()
    expect(body.prompt).toBe('prompt')
  })

  it('does not append a size hint to Agent tool requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true, allowPromptRewrite: true },
      prompt: 'Generate at 1024x1024 resolution. prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [],
      skipCodexCliSizePrompt: true,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.prompt).toBe('Generate at 1024x1024 resolution. prompt')
  })

  it('records actual params returned on Images API responses in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
      data: [{
        b64_json: 'aW1hZ2U=',
        revised_prompt: '移除靴子',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.actualParams).toEqual({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
    })
    expect(result.actualParamsList).toEqual([{
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
    }])
    expect(result.revisedPrompts).toEqual(['移除靴子'])
  })

  it('does not synthesize actual quality in Codex CLI mode when the API omits it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_format: 'png',
      size: '1033x1522',
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result.actualParams).toEqual({
      output_format: 'png',
      size: '1033x1522',
    })
    expect(result.actualParams?.quality).toBeUndefined()
    expect(result.actualParamsList).toEqual([{
      output_format: 'png',
      size: '1033x1522',
    }])
  })

  it('streams Images API partial images and resolves the final completed image', async () => {
    const streamBody = [
      'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
      '',
      'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","size":"1024x1024","quality":"high","output_format":"png"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const partialImages: string[] = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        streamPartialImages: 3,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
          streamPartialImages: 3,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string }) => partialImages.push(partial.image),
    } as any)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toMatchObject({
      stream: true,
      partial_images: 3,
    })
    expect(partialImages).toEqual(['data:image/png;base64,cGFydGlhbA=='])
    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'png',
        quality: 'high',
        size: '1024x1024',
      },
      actualParamsList: [{
        output_format: 'png',
        quality: 'high',
        size: '1024x1024',
      }],
    })
  })

  it('resolves a streamed completed image returned as a URL after ping events', async () => {
    const imageUrl = 'https://example.com/generated.png'
    const streamBody = [
      ': PING',
      '',
      'event: image_generation.completed',
      `data: {"type":"image_generation.completed","url":"${imageUrl}"}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(imageUrl)
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.rawImageUrls).toEqual([imageUrl])
  })

  it('suggests disabling streaming when a streaming request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid character \':\' looking for beginning of value', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)).rejects.toThrow('invalid character \':\' looking for beginning of value\n提示：当前使用的 API 可能不支持流式传输，请尝试关闭「流式传输」功能。')
  })

  it('preserves malformed stream event text when suggesting disabling streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: invalid character \':\' looking for beginning of value\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)).rejects.toThrow('invalid character \':\' looking for beginning of value\n提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。')
  })

  it('reports malformed event-stream responses without data events', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid character \':\' looking for beginning of value\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)).rejects.toThrow('未从流式响应中解析到有效的 data 事件\n提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。')
  })

  it('does not expect revised prompts on official Images API stream completed events', async () => {
    const streamBody = [
      'data: {"created_at":1779112721,"type":"image_generation.completed","b64_json":"ZmluYWw=","background":"opaque","output_format":"jpeg","quality":"medium","sequence_number":0,"size":"1448x1086","usage":{"total_tokens":1569}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'jpeg',
        quality: 'medium',
        size: '1448x1086',
      },
      revisedPrompts: [undefined],
    })
  })

  it('parses Images API stream result events with data b64_json', async () => {
    const streamBody = [
      'data: {"object":"image.generation.chunk","created":1779551054,"model":"gpt-image-2"}',
      '',
      'data: {"object":"image.generation.result","created":1779551140,"model":"gpt-image-2","data":[{"b64_json":"ZmluYWw=","revised_prompt":"rewritten"}],"size":"1024x1536","quality":"medium","output_format":"png"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'png',
        quality: 'medium',
        size: '1024x1536',
      },
      actualParamsList: [{
        output_format: 'png',
        quality: 'medium',
        size: '1024x1536',
      }],
      revisedPrompts: ['rewritten'],
    })
  })

  it('splits Images API streaming into concurrent single-image requests when n is greater than 1', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const streamBody = [
        'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
        '',
        'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","size":"1024x1024","quality":"high","output_format":"png"}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const partials: Array<{ image: string; requestIndex?: number }> = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        streamPartialImages: 1,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
          streamPartialImages: 1,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string; requestIndex?: number }) => partials.push(partial),
    } as any)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.n).toBe(1)
      expect(body.stream).toBe(true)
      expect(body.partial_images).toBe(1)
    }
    expect(result.images).toHaveLength(2)
    expect(result.images).toEqual([
      'data:image/png;base64,ZmluYWw=',
      'data:image/png;base64,ZmluYWw=',
    ])
    expect(partials.map((partial) => partial.requestIndex).sort()).toEqual([0, 1])
    expect(partials.map((partial) => partial.image)).toEqual([
      'data:image/png;base64,cGFydGlhbA==',
      'data:image/png;base64,cGFydGlhbA==',
    ])
  })

  it('keeps successful Images API concurrent results when one request fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const callIndex = fetchMock.mock.calls.length
      if (callIndex === 2) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({
        data: [{ b64_json: `aW1hZ2Ut${callIndex}` }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 3 },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.images).toEqual([
      'data:image/png;base64,aW1hZ2Ut1',
      'data:image/png;base64,aW1hZ2Ut3',
    ])
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: 'Failed to fetch' }])
    expect(result.actualParams).toMatchObject({ n: 2 })
  })

  it('streams Responses API partial images and resolves the completed response image', async () => {
    const streamBody = [
      'data: {"type":"response.image_generation_call.partial_image","partial_image_index":0,"partial_image_b64":"cGFydGlhbA=="}',
      '',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"ZmluYWw=","revised_prompt":"rewritten","size":"1024x1024"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const partialImages: string[] = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        streamImages: true,
        streamPartialImages: 1,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          apiMode: 'responses',
          streamImages: true,
          streamPartialImages: 1,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string }) => partialImages.push(partial.image),
    } as any)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBe(true)
    expect(body.tools[0].partial_images).toBe(1)
    expect(partialImages).toEqual(['data:image/png;base64,cGFydGlhbA=='])
    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
      revisedPrompts: ['rewritten'],
    })
  })

  it('keeps successful Responses API concurrent results when one request fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const callIndex = fetchMock.mock.calls.length
      if (callIndex === 3) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({
        output: [{ type: 'image_generation_call', result: `aW1hZ2Ut${callIndex}` }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 3 },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.images).toEqual([
      'data:image/png;base64,aW1hZ2Ut1',
      'data:image/png;base64,aW1hZ2Ut2',
    ])
    expect(result.failedRequests).toEqual([{ requestIndex: 2, error: 'Failed to fetch' }])
    expect(result.actualParams).toMatchObject({ n: 2 })
  })

  it('parses Responses API image result objects in gallery mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        result: { b64_json: 'ZmluYWw=' },
        size: '1024x1024',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
    })
  })

  it('keeps Responses API stream output item images when completed response omits result', async () => {
    const streamBody = [
      'data: {"type":"response.output_item.done","item":{"id":"img-call-1","type":"image_generation_call","status":"generating","action":"generate","result":"ZmluYWw=","size":"1024x1024"},"output_index":0}',
      '',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","status":"completed","result":""}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          apiMode: 'responses',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
    })
  })

  it('uses the same-origin API proxy path when API proxy is enabled', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses the same-origin API proxy path when API proxy is enabled and base URL is empty', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: '',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses the same-origin API proxy path for sync custom providers', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: '',
        apiKey: 'test-key',
        apiProxy: true,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          template: 'http-image',
          submit: {
            path: 'custom/images',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt', background: '$params.background' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom-sync',
          provider: 'custom-sync',
          baseUrl: '',
          apiKey: 'test-key',
          model: 'model',
          apiProxy: true,
        }],
        activeProfileId: 'profile-custom-sync',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/custom/images',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.background).toBe('transparent')
  })

  it('splits Codex CLI sync custom provider output count into concurrent n=1 requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: `aW1hZ2Ut${fetchMock.mock.calls.length}` }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        codexCli: true,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          submit: {
            path: 'images/generations',
            body: {
              model: '$profile.model',
              prompt: '$prompt',
              size: '$params.size',
              quality: '$params.quality',
              n: '$params.n',
            },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-sync-profile',
          provider: 'custom-sync',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          codexCli: true,
        }],
        activeProfileId: 'custom-sync-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x768', quality: 'high', n: 3 },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [index, [, init]] of fetchMock.mock.calls.entries()) {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.n).toBe(1)
      expect(body.prompt).toContain('Generate at 1024x768 resolution.')
      expect(body.prompt).toContain(`第 ${index + 1} 张，共 3 张`)
      expect(body.prompt.endsWith('prompt')).toBe(true)
      expect(body).not.toHaveProperty('size')
      expect(body).not.toHaveProperty('quality')
    }
    expect(result.images).toHaveLength(3)
    expect(result.actualParams).toMatchObject({ n: 3 })
  })

  it('keeps custom prompts unchanged when Codex CLI prompt transforms are disabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        codexCli: true,
        allowPromptRewrite: true,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          submit: {
            path: 'images/generations',
            body: { prompt: '$prompt', size: '$params.size', quality: '$params.quality' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          provider: 'custom-sync',
          baseUrl: 'https://api.example.com/v1',
          codexCli: true,
        }],
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x768', quality: 'high' },
      inputImageDataUrls: [],
      skipCodexCliSizePrompt: true,
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ prompt: 'prompt' })
  })

  it('keeps successful Codex CLI sync custom results when one request fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const callIndex = fetchMock.mock.calls.length
      if (callIndex === 2) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ data: [{ b64_json: `aW1hZ2Ut${callIndex}` }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        codexCli: true,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          submit: {
            path: 'images/generations',
            body: { n: '$params.n' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          provider: 'custom-sync',
          baseUrl: 'https://api.example.com/v1',
          codexCli: true,
        }],
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 3 },
      inputImageDataUrls: [],
    })

    expect(result.images).toHaveLength(2)
    expect(result.failedRequests).toEqual([{ requestIndex: 1, error: 'Failed to fetch' }])
    expect(result.actualParams).toMatchObject({ n: 2 })
  })

  it('splits a sync edit mapping when the same custom provider has async generation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        codexCli: true,
        customProviders: [{
          id: 'custom-mixed',
          name: 'Custom Mixed',
          submit: {
            path: 'images/generations',
            body: { n: '$params.n' },
            taskIdPath: 'task_id',
          },
          editSubmit: {
            path: 'images/edits',
            body: { prompt: '$prompt', size: '$params.size', quality: '$params.quality', n: '$params.n', background: '$params.background' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
          poll: {
            path: 'images/tasks/{task_id}',
            statusPath: 'status',
            successValues: ['completed'],
            failureValues: ['failed'],
            result: { b64JsonPaths: ['result.data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          provider: 'custom-mixed',
          baseUrl: 'https://api.example.com/v1',
          codexCli: true,
        }],
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x768', quality: 'high', n: 3 },
      nativeTransparentBackground: true,
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })

    const submitCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.example.com/'))
    expect(submitCalls).toHaveLength(3)
    for (const [index, [url, init]] of submitCalls.entries()) {
      expect(url).toBe('https://api.example.com/v1/images/edits')
      const body = (init as RequestInit).body as FormData
      expect(String(body.get('prompt'))).toContain('Generate at 1024x768 resolution.')
      expect(String(body.get('prompt'))).toContain(`第 ${index + 1} 张，共 3 张`)
      expect(String(body.get('prompt')).endsWith('prompt')).toBe(true)
      expect(body.get('size')).toBeNull()
      expect(body.get('quality')).toBeNull()
      expect(body.get('n')).toBe('1')
      expect(body.get('background')).toBe('transparent')
    }
  })

  it('submits raw base64 reference images for custom providers via $inputImages.base64', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-raw-base64',
          name: 'Custom Raw Base64',
          submit: {
            path: 'images/generations',
            body: { model: '$profile.model', prompt: '$prompt', image: '$inputImages.base64' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-raw-base64-profile',
          provider: 'custom-raw-base64',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
        }],
        activeProfileId: 'custom-raw-base64-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2Ux', 'data:image/jpeg;base64,aW1hZ2Uy'],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toEqual(['aW1hZ2Ux', 'aW1hZ2Uy'])
  })

  it('submits reference image URLs for custom providers via $inputImages.urls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-links',
          name: 'Custom Links',
          submit: {
            path: 'images/generations',
            body: { model: '$profile.model', prompt: '$prompt', image: '$inputImages.urls' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-links-profile',
          provider: 'custom-links',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
        }],
        activeProfileId: 'custom-links-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U=', 'data:image/png;base64,aW1hZ2Uy'],
      inputImageUrls: ['https://cdn.example.com/a.png?e=1&token=x', 'https://oss.example.com/b.png'],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toEqual([
      'https://cdn.example.com/a.png?e=1&token=x',
      'https://oss.example.com/b.png',
    ])
  })

  it('omits the image field when there are no reference images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-links',
          name: 'Custom Links',
          submit: {
            path: 'images/generations',
            body: { model: '$profile.model', prompt: '$prompt', image: '$inputImages.urls' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-links-profile',
          provider: 'custom-links',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
        }],
        activeProfileId: 'custom-links-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toBeUndefined()
  })

  it('rejects local reference images when the provider only accepts link references', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-links',
          name: 'Custom Links',
          submit: {
            path: 'images/generations',
            body: { model: '$profile.model', prompt: '$prompt', image: '$inputImages.urls' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-links-profile',
          provider: 'custom-links',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
        }],
        activeProfileId: 'custom-links-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U=', 'data:image/png;base64,aW1hZ2Uy'],
      inputImageUrls: ['https://cdn.example.com/a.png', null],
    })).rejects.toThrow('只接受链接参考图')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats $inputImages.urls as optional when the template also sends base64 images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-mixed',
          name: 'Custom Mixed',
          submit: {
            path: 'images/generations',
            body: { model: '$profile.model', prompt: '$prompt', image: '$inputImages.base64', image_urls: '$inputImages.urls' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-mixed-profile',
          provider: 'custom-mixed',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
        }],
        activeProfileId: 'custom-mixed-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2Ux', 'data:image/png;base64,aW1hZ2Uy'],
      inputImageUrls: ['https://cdn.example.com/a.png', null],
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toEqual(['aW1hZ2Ux', 'aW1hZ2Uy'])
    expect(body.image_urls).toEqual(['https://cdn.example.com/a.png'])
  })

  it('keeps Codex CLI async custom provider output count in one submitted task', async () => {
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        result: {
          data: [
            { b64_json: 'aW1hZ2UtMQ==' },
            { b64_json: 'aW1hZ2UtMg==' },
            { b64_json: 'aW1hZ2UtMw==' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        codexCli: true,
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          submit: {
            path: 'images/generations',
            body: { prompt: '$prompt', size: '$params.size', quality: '$params.quality', n: '$params.n' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            statusPath: 'status',
            successValues: ['completed'],
            failureValues: ['failed'],
            result: { b64JsonPaths: ['result.data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          provider: 'custom-async',
          baseUrl: 'https://api.example.com/v1',
          codexCli: true,
        }],
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x768', quality: 'high', n: 3 },
      inputImageDataUrls: [],
      onCustomTaskEnqueued,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const submitBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(submitBody).toMatchObject({
      prompt: 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:\nGenerate at 1024x768 resolution. prompt',
      n: 3,
    })
    expect(submitBody).not.toHaveProperty('size')
    expect(submitBody).not.toHaveProperty('quality')
    expect(onCustomTaskEnqueued).toHaveBeenCalledOnce()
    expect(result.images).toHaveLength(3)
  })

  it('adds the transparent background hint when an async custom task rejects it', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'failed',
        error: 'Transparent background is not supported for this model.',
      }), { status: 200 }))

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-async-background',
          name: 'Custom Async Background',
          submit: {
            path: 'images/generations',
            body: { prompt: '$prompt', background: '$params.background' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            statusPath: 'status',
            successValues: ['completed'],
            failureValues: ['failed'],
            errorPath: 'error',
            result: { b64JsonPaths: ['result.data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom-async-background',
          provider: 'custom-async-background',
          baseUrl: 'https://api.example.com/v1',
        }],
        activeProfileId: 'profile-custom-async-background',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    })).rejects.toThrow('请将「透明背景实现方式」切换为「本地后处理」')
  })

  it('rejects API proxy for async custom providers', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: '',
        apiKey: 'test-key',
        apiProxy: true,
        customProviders: [{
          id: 'custom-async-proxy',
          name: 'Custom Async Proxy',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 1,
            statusPath: 'status',
            successValues: ['done'],
            failureValues: ['failed'],
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom-async-proxy',
          provider: 'custom-async-proxy',
          baseUrl: '',
          apiKey: 'test-key',
          model: 'model',
          apiProxy: true,
        }],
        activeProfileId: 'profile-custom-async-proxy',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow('异步任务的自定义服务商')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the same-origin API proxy path when API proxy is locked', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.stubEnv('VITE_API_PROXY_LOCKED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not add cache request headers that require extra CORS allow-list entries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers).not.toHaveProperty('Pragma')
    expect(headers).not.toHaveProperty('Cache-Control')
    expect((init as RequestInit).cache).toBe('no-store')
  })

  it('ignores stored API proxy settings when the current deployment has no proxy', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('polls custom async tasks immediately and keeps polling after transient network errors', async () => {
    vi.useFakeTimers()
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          status: 'SUCCESS',
          data: {
            data: [{ b64_json: 'aW1hZ2U=' }],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            query: { async: 'true' },
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 1,
            statusPath: 'data.status',
            successValues: ['SUCCESS'],
            failureValues: ['FAILURE'],
            errorPath: 'data.fail_reason',
            result: {
              imageUrlPaths: ['data.data.data.*.url'],
              b64JsonPaths: ['data.data.data.*.b64_json'],
            },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom',
          provider: 'custom-async',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
          timeout: 60,
        }],
        activeProfileId: 'profile-custom',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onCustomTaskEnqueued,
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'task-1' })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/images/tasks/task-1')
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toEqual({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the built-in sub2api async endpoints and result mapping', async () => {
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'imgtask-1',
        status: 'processing',
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: 'imgtask-1',
        status: 'completed',
        result: {
          data: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://sub2api.example.com/v1',
        apiKey: 'test-key',
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'sub2api-profile',
          provider: 'sb2api-async',
          baseUrl: 'https://sub2api.example.com/v1',
          apiKey: 'test-key',
        }],
        activeProfileId: 'sub2api-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onCustomTaskEnqueued,
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://sub2api.example.com/v1/images/generations/async')
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'prompt',
      n: 1,
    })
    expect(fetchMock.mock.calls[1][0]).toBe('https://sub2api.example.com/v1/images/tasks/imgtask-1')
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'imgtask-1' })
    expect(result).toEqual({ images: ['data:image/png;base64,aW1hZ2U='] })
  })

  it('does not apply submit timeout to custom async polling after receiving a task id', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'IN_PROGRESS' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          status: 'SUCCESS',
          data: {
            data: [{ b64_json: 'aW1hZ2U=' }],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            query: { async: 'true' },
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 5,
            statusPath: 'data.status',
            successValues: ['SUCCESS'],
            failureValues: ['FAILURE'],
            result: {
              b64JsonPaths: ['data.data.data.*.b64_json'],
            },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom',
          provider: 'custom-async',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
          timeout: 1,
        }],
        activeProfileId: 'profile-custom',
        timeout: 1,
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    await vi.advanceTimersByTimeAsync(6000)

    await expect(promise).resolves.toEqual({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
  })

  it.each(['等待下次查询', '正在查询'])('自定义任务入队后可在%s时取消，不重新提交生成', async (stage) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ task_id: 'saved-task' }), { status: 202 })
      if (stage === '等待下次查询') return new Response(JSON.stringify({ status: 'processing' }))
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
    })
    const profile = createDefaultOpenAIProfile({ id: 'async', provider: 'sb2api-async', apiKey: 'mock-key', baseUrl: 'https://custom.example.test/v1', timeout: 1 })
    const pending = callImageApi({
      settings: { ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id },
      prompt: '画猫', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [], signal: controller.signal, onCustomTaskEnqueued,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'saved-task' })
    controller.abort(new DOMException('已停止查询', 'AbortError'))

    expect(await pending).toMatchObject({ name: 'AbortError', message: '已停止查询' })
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('自定义任务长期返回未知状态时有界超时，保留任务编号且不会重新付费提交', async () => {
    vi.useFakeTimers()
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { task_id: 'saved-task' } : { status: 'unknown' })))
    const profile = createDefaultOpenAIProfile({ id: 'async', provider: 'sb2api-async', apiKey: 'mock-key', baseUrl: 'https://custom.example.test/v1', timeout: 1 })
    const pending = callImageApi({
      settings: { ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id },
      prompt: '画猫', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [], onCustomTaskEnqueued,
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(599_000)
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)

    expect(await pending).toMatchObject({ name: 'AbortError', message: expect.stringContaining('600 秒') })
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'saved-task' })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    const finishedCount = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(finishedCount)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('恢复自定义任务只查询原编号，并遵守较长的配置超时', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ status: 'processing' })))
    const profile = createDefaultOpenAIProfile({ provider: 'sb2api-async', baseUrl: 'https://custom.example.test/v1', timeout: 900 })
    const provider = getCustomProviderDefinition(DEFAULT_SETTINGS, 'sb2api-async')!
    const pending = getCustomQueuedImageResult(profile, provider, 'original-task', DEFAULT_PARAMS).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(300_000)

    expect(await pending).toMatchObject({ name: 'AbortError', message: expect.stringContaining('900 秒') })
    expect(fetchMock.mock.calls.every(([url, init]) => String(url).endsWith('/images/tasks/original-task') && init?.method === 'GET')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('恢复自定义任务可主动停止，取消后不再轮询', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ status: 'processing' })))
    const controller = new AbortController()
    const profile = createDefaultOpenAIProfile({ provider: 'sb2api-async', baseUrl: 'https://custom.example.test/v1', timeout: 1 })
    const provider = getCustomProviderDefinition(DEFAULT_SETTINGS, 'sb2api-async')!
    const pending = getCustomQueuedImageResult(profile, provider, 'original-task', DEFAULT_PARAMS, controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new DOMException('已停止查询', 'AbortError'))

    expect(await pending).toMatchObject({ name: 'AbortError', message: '已停止查询' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
