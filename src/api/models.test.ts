import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAvailableModels, parseAvailableModels } from './models'
import { apiFetch } from '../lib/platform'
import { shouldUseApiProxy } from '../lib/devProxy'

vi.mock('../lib/platform', () => ({ apiFetch: vi.fn() }))
vi.mock('../lib/devProxy', async (original) => ({
  ...await original<typeof import('../lib/devProxy')>(),
  readClientDevProxyConfig: () => null,
  shouldUseApiProxy: vi.fn(() => false),
}))

const profile = { baseUrl: 'https://sub2api.example.com/v1', apiKey: 'test-key', apiProxy: false }

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('模型列表解析', () => {
  it('读取 OpenAI 格式，去重并丢弃无效模型', () => {
    expect(parseAvailableModels({ data: [{ id: ' image-a ' }, { id: 'image-a' }, { id: 'image-b', name: '图片 B' }, {}, null] }))
      .toEqual([{ id: 'image-a' }, { id: 'image-b', name: '图片 B' }])
  })
  it('兼容直接数组和 models 数组，允许空权限列表', () => {
    expect(parseAvailableModels(['image-a'])).toEqual([{ id: 'image-a' }])
    expect(parseAvailableModels({ models: ['image-b'] })).toEqual([{ id: 'image-b' }])
    expect(parseAvailableModels({ data: [] })).toEqual([])
  })
  it('拒绝错误结构和全无效条目', () => {
    expect(() => parseAvailableModels({ message: 'not models' })).toThrow('模型列表格式无效')
    expect(() => parseAvailableModels({ data: [{}] })).toThrow('没有有效的模型 ID')
  })
})

describe('按 Key 读取模型', () => {
  it('发送 GET 和 Bearer 鉴权，不重复拼接 v1', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'image-a' }] })))
    expect(await fetchAvailableModels(profile)).toEqual([{ id: 'image-a' }])
    expect(apiFetch).toHaveBeenCalledWith('https://sub2api.example.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer test-key', Accept: 'application/json' }, cache: 'no-store',
    }))
  })
  it('缺少地址或 Key 时不发送请求', async () => {
    await expect(fetchAvailableModels({ ...profile, baseUrl: '' })).rejects.toThrow('请先填写 API 地址')
    await expect(fetchAvailableModels({ ...profile, apiKey: ' ' })).rejects.toThrow('请先填写 API Key')
    expect(apiFetch).not.toHaveBeenCalled()
  })
  it.each([[401, 'Key 无效'], [403, '没有读取模型的权限'], [404, '未找到模型接口'], [429, '读取过于频繁'], [502, 'HTTP 502']])('将 HTTP %i 转为可理解的提示', async (status, message) => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('敏感响应不应显示', { status }))
    await expect(fetchAvailableModels(profile)).rejects.toThrow(String(message))
  })
  it('通过同源代理读取 models', async () => {
    vi.mocked(shouldUseApiProxy).mockReturnValueOnce(true)
    vi.mocked(apiFetch).mockResolvedValue(new Response('{"data":[]}'))
    await fetchAvailableModels({ ...profile, apiProxy: true })
    expect(apiFetch).toHaveBeenCalledWith('/api-proxy/models', expect.anything())
  })
  it('对非 JSON 和网络错误显示诊断信息', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('<html>登录页面</html>'))
    await expect(fetchAvailableModels(profile)).rejects.toThrow('未返回有效 JSON')
    vi.mocked(apiFetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(fetchAvailableModels(profile)).rejects.toThrow('跨域设置')
  })
  it('超时后取消请求', async () => {
    vi.useFakeTimers()
    vi.mocked(apiFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const result = expect(fetchAvailableModels(profile)).rejects.toThrow('读取模型超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await result
  })
})
