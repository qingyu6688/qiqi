import { createFalClient } from '@fal-ai/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi, getFalQueuedImageResult } from './falAiImageApi'
import { withImageRequestSlot } from './imageRequestQueue'

const falMock = vi.hoisted(() => ({
  subscribe: vi.fn(),
  queue: {
    subscribeToStatus: vi.fn(),
    result: vi.fn(),
  },
}))

vi.mock('@fal-ai/client', () => ({ createFalClient: vi.fn(() => falMock) }))

const requestOptions = () => ({ settings: DEFAULT_SETTINGS, prompt: '测试图片', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [] })
const completedResult = () => ({ requestId: 'req-1', data: { images: [{ b64_json: 'aW1hZ2U=' }] } })

describe('callFalAiImageApi', () => {
  beforeEach(() => {
    vi.mocked(createFalClient).mockReset().mockReturnValue(falMock as unknown as ReturnType<typeof createFalClient>)
    falMock.subscribe.mockReset()
    falMock.queue.subscribeToStatus.mockReset()
    falMock.queue.result.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses the default fal endpoint without proxyUrl', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      fetch: expect.any(Function),
    })
  })

  it('passes custom fal API URL to the SDK proxyUrl option', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    }))

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'fal-key',
      suppressLocalCredentialsWarning: true,
      fetch: expect.any(Function),
      proxyUrl: 'https://fal-proxy.example.com/api/fal',
    })
  })

  it('uses the GPT Image 2.5 text-to-image endpoint and preserves max quality', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, quality: 'max' },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.5/sunburst', apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2.5/sunburst/text-to-image', expect.objectContaining({
      input: expect.objectContaining({ quality: 'max' }),
    }))
  })

  it('uses the GPT Image 2.5 edit endpoint', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, createDefaultFalProfile({ model: 'openai/gpt-image-2.5/flare', apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2.5/flare/edit', expect.anything())
  })

  it('requests a native transparent background', async () => {
    falMock.subscribe.mockResolvedValue({
      requestId: 'req-1',
      data: { images: [{ b64_json: 'aW1hZ2U=' }] },
    })

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'webp', transparent_output: true },
      nativeTransparentBackground: true,
      inputImageDataUrls: [],
    }, createDefaultFalProfile({ apiKey: 'fal-key' }))

    expect(falMock.subscribe).toHaveBeenCalledWith('openai/gpt-image-2', expect.objectContaining({
      input: expect.objectContaining({ background: 'transparent' }),
    }))
  })

  it('两项订阅卡住时按配置超时释放名额，已入队的请求编号仍已交给存储', async () => {
    vi.useFakeTimers()
    const onFalRequestEnqueued = vi.fn()
    falMock.subscribe.mockImplementationOnce((_endpoint, options) => {
      options.onEnqueue('saved-request-1')
      return new Promise(() => undefined)
    }).mockImplementationOnce((_endpoint, options) => {
      options.onEnqueue('saved-request-2')
      return new Promise(() => undefined)
    }).mockResolvedValueOnce(completedResult())
    const profile = createDefaultFalProfile({ apiKey: 'test-key', timeout: 0.05 })
    const first = callFalAiImageApi({ ...requestOptions(), onFalRequestEnqueued }, profile).catch((error: unknown) => error)
    const second = callFalAiImageApi({ ...requestOptions(), onFalRequestEnqueued }, profile).catch((error: unknown) => error)
    const third = callFalAiImageApi(requestOptions(), profile)

    await vi.advanceTimersByTimeAsync(49)
    expect(falMock.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toMatchObject({ name: 'AbortError', message: expect.stringContaining('请求超时') })
    expect(await second).toMatchObject({ name: 'AbortError' })
    expect((await third).images).toHaveLength(1)
    expect(onFalRequestEnqueued).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'saved-request-1' }))
    expect(onFalRequestEnqueued).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'saved-request-2' }))
    expect(falMock.subscribe).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('排队等待不消耗服务商超时时间', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = withImageRequestSlot(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
    const second = withImageRequestSlot(() => new Promise<void>((resolve) => { releaseSecond = resolve }))
    falMock.subscribe.mockResolvedValue(completedResult())
    const queued = callFalAiImageApi(requestOptions(), createDefaultFalProfile({ timeout: 0.05 }))

    await vi.advanceTimersByTimeAsync(500)
    expect(falMock.subscribe).not.toHaveBeenCalled()
    releaseFirst()
    releaseSecond()
    await Promise.all([first, second])
    expect((await queued).images).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('调用者停止时中止订阅并清理超时，不等待 SDK 返回', async () => {
    vi.useFakeTimers()
    falMock.subscribe.mockImplementation(() => new Promise(() => undefined))
    const controller = new AbortController()
    const result = callFalAiImageApi({ ...requestOptions(), signal: controller.signal }, createDefaultFalProfile({ timeout: 60 })).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const requestSignal = falMock.subscribe.mock.calls[0][1].abortSignal as AbortSignal
    expect(requestSignal.aborted).toBe(false)

    controller.abort(new DOMException('已停止生成', 'AbortError'))
    expect(await result).toMatchObject({ name: 'AbortError', message: '已停止生成' })
    expect(requestSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('图片链接下载也使用本次请求信号，取消后不继续占用名额', async () => {
    falMock.subscribe.mockResolvedValue({ requestId: 'req-1', data: { images: [{ url: 'https://image.example.test/result.png' }] } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    const result = callFalAiImageApi({ ...requestOptions(), signal: controller.signal }, createDefaultFalProfile()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const downloadSignal = fetchMock.mock.calls[0][1]?.signal
    controller.abort(new DOMException('已停止生成', 'AbortError'))

    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(downloadSignal?.aborted).toBe(true)
    expect(falMock.subscribe).toHaveBeenCalledOnce()
  })

  it('同时使用两个配置时各自持有独立客户端和凭据', async () => {
    const firstSubscribe = vi.fn(async () => ({ requestId: 'first', data: { images: [{ b64_json: 'Zmlyc3Q=' }] } }))
    const secondSubscribe = vi.fn(async () => ({ requestId: 'second', data: { images: [{ b64_json: 'c2Vjb25k' }] } }))
    vi.mocked(createFalClient).mockReturnValueOnce({ subscribe: firstSubscribe } as unknown as ReturnType<typeof createFalClient>)
      .mockReturnValueOnce({ subscribe: secondSubscribe } as unknown as ReturnType<typeof createFalClient>)
    const results = await Promise.all([
      callFalAiImageApi(requestOptions(), createDefaultFalProfile({ apiKey: 'first-key' })),
      callFalAiImageApi(requestOptions(), createDefaultFalProfile({ apiKey: 'second-key' })),
    ])

    expect(vi.mocked(createFalClient).mock.calls.map(([config]) => config?.credentials)).toEqual(['first-key', 'second-key'])
    expect(firstSubscribe).toHaveBeenCalledOnce()
    expect(secondSubscribe).toHaveBeenCalledOnce()
    expect(results[0].images[0]).toContain('Zmlyc3Q=')
    expect(results[1].images[0]).toContain('c2Vjb25k')
  })

  it('计费 POST 返回网关错误时阻止 SDK 默认重发', async () => {
    const actual = await vi.importActual<typeof import('@fal-ai/client')>('@fal-ai/client')
    vi.mocked(createFalClient).mockImplementation(actual.createFalClient)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: '上游暂不可用' }), { status: 502, headers: { 'Content-Type': 'application/json' } }))

    await expect(callFalAiImageApi(requestOptions(), createDefaultFalProfile({ apiKey: 'test-key' }))).rejects.toThrow('上游暂不可用')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
  })

  it('SDK 遗漏信号的结果读取仍会继承本次请求的取消信号', async () => {
    falMock.subscribe.mockImplementation(async () => {
      const config = vi.mocked(createFalClient).mock.calls[0][0]!
      await config.fetch!('https://queue.fal.run/example/result', { method: 'GET' })
      return completedResult()
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    const result = callFalAiImageApi({ ...requestOptions(), signal: controller.signal }, createDefaultFalProfile()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort(new DOMException('已停止', 'AbortError'))

    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('恢复已有队列请求只查询原编号，不重新生成，并把信号传入结果读取', async () => {
    falMock.queue.subscribeToStatus.mockResolvedValue({ status: 'COMPLETED' })
    falMock.queue.result.mockResolvedValue(completedResult())
    const result = await getFalQueuedImageResult(createDefaultFalProfile(), 'openai/gpt-image-2', 'saved-request', DEFAULT_PARAMS)

    expect(result.images).toHaveLength(1)
    expect(falMock.subscribe).not.toHaveBeenCalled()
    expect(falMock.queue.subscribeToStatus).toHaveBeenCalledWith('openai/gpt-image-2', expect.objectContaining({ requestId: 'saved-request', abortSignal: expect.any(AbortSignal) }))
    expect(falMock.queue.result).toHaveBeenCalledWith('openai/gpt-image-2', expect.objectContaining({ requestId: 'saved-request', abortSignal: expect.any(AbortSignal) }))
  })

})
