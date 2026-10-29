import type { ApiProfile } from '../types'
import type { AvailableModel } from '../types/models'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../lib/devProxy'
import { apiFetch } from '../lib/platform'

const MODEL_REQUEST_TIMEOUT_MS = 30_000

export function parseAvailableModels(payload: unknown): AvailableModel[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const entries = Array.isArray(payload) ? payload : record?.data ?? record?.models
  if (!Array.isArray(entries)) throw new Error('模型列表格式无效，请确认 API 地址支持 /v1/models')
  const models: AvailableModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    const id = typeof entry === 'string' ? entry.trim() : typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    models.push({ id, ...(name && name !== id ? { name } : {}) })
  }
  if (entries.length && !models.length) throw new Error('模型列表中没有有效的模型 ID')
  return models
}

function getModelRequestError(status: number): string {
  if (status === 401) return 'Key 无效或已过期，请检查后重新读取模型'
  if (status === 403) return '当前 Key 没有读取模型的权限，请检查 sub2api 的密钥分组'
  if (status === 404) return '未找到模型接口，请检查 API 地址和 /v1 路径'
  if (status === 429) return '读取过于频繁，请稍后重试'
  return `读取模型失败：HTTP ${status}`
}

export async function fetchAvailableModels(profile: Pick<ApiProfile, 'baseUrl' | 'apiKey' | 'apiProxy'>, signal?: AbortSignal): Promise<AvailableModel[]> {
  const proxyConfig = readClientDevProxyConfig()
  const useProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  if (!profile.baseUrl.trim() && !useProxy) throw new Error('请先填写 API 地址')
  if (!profile.apiKey.trim()) throw new Error('请先填写 API Key')
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('读取模型超时，请检查网络后重试', 'TimeoutError')), MODEL_REQUEST_TIMEOUT_MS)
  try {
    const response = await apiFetch(buildApiUrl(profile.baseUrl, 'models', proxyConfig, useProxy), {
      method: 'GET',
      headers: { Authorization: `Bearer ${profile.apiKey.trim()}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(getModelRequestError(response.status))
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw new Error('模型接口未返回有效 JSON，请检查 API 地址或代理配置')
    }
    return parseAvailableModels(payload)
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof TypeError) throw new Error('无法连接模型接口，请检查网络和跨域设置；也可使用 API 代理或桌面版')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
