import type { AppSettings, ResponsesOutputItem, TaskParams } from '../types'
import { blobToDataUrl } from './dataUrl'
import { apiFetch, isTauri } from './platform'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024
export const PROMPT_REWRITE_GUARD_PREFIX = 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'

export interface CallApiOptions {
  signal?: AbortSignal
  onRequestStarted?: () => void
  settings: AppSettings
  prompt: string
  params: TaskParams
  nativeTransparentBackground?: boolean
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  /** 与 inputImageDataUrls 按索引对齐的原链接，不是通过链接添加的为 null */
  inputImageUrls?: (string | null)[]
  maskDataUrl?: string
  skipCodexCliSizePrompt?: boolean
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 并发多图请求中失败的单张请求 */
  failedRequests?: Array<{ requestIndex: number; error: string }>
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

export function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  return b64.trim() ? b64 : undefined
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

const IMAGE_TOOL_DROPPED_ERROR = /Tool choice 'required' must be specified with 'tools' parameter\./i
export const IMAGE_TOOL_DROPPED_HINT = '提示：当前使用的 API 可能未正确转发图像生成工具，请尝试更换支持该工具的接口或模型。'
export const IMAGE_FETCH_CORS_HINT = ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'
export const STREAMING_UNSUPPORTED_HINT = '提示：当前使用的 API 可能不支持流式传输，请尝试关闭「流式传输」功能。'
export const STREAMING_FORMAT_HINT = '提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。'
export const TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT = '提示：当前使用的 API 不支持为该模型使用原生透明背景，请将「透明背景实现方式」切换为「本地后处理」。'

export function appendStreamingUnsupportedHint(message: string): string {
  return message ? `${message}\n${STREAMING_UNSUPPORTED_HINT}` : STREAMING_UNSUPPORTED_HINT
}

export function appendStreamingFormatHint(message: string): string {
  return message ? `${message}\n${STREAMING_FORMAT_HINT}` : STREAMING_FORMAT_HINT
}

export function maybeAppendTransparentBackgroundHint(message: string): string {
  if (!/transparent background is not supported for this model\.?/i.test(message)) return message
  return `${message}\n${TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT}`
}

/** 部分 API 转发 Responses 请求时会丢弃 image_generation 工具，却保留 tool_choice，服务端因此报错 */
export function maybeAppendImageToolDroppedHint(message: string): string {
  if (!IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  return `${message}\n${IMAGE_TOOL_DROPPED_HINT}`
}

/** 请求超时中止时使用的原因，替代浏览器默认的英文“signal is aborted without reason”；仍为 AbortError，不改变错误分类 */
export function createRequestTimeoutError(timeoutSeconds: number) {
  return new DOMException(`请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`, 'AbortError')
}

/** 排除明确与流式无关的状态码后追加提示 */
export function maybeAppendStreamingHint(message: string, status: number, streamImages?: boolean): string {
  const transparentMessage = maybeAppendTransparentBackgroundHint(message)
  if (transparentMessage !== message) return transparentMessage
  if (IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  if (!streamImages) return message
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return message
  }
  return appendStreamingUnsupportedHint(message)
}

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await apiFetch(url, {
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      // 客户端由 Rust 侧发出请求，不存在跨域问题，也不需要 no-cors 探测
      if (isTauri) throw new Error(`图片链接下载失败（可能因链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(`图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`)
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(`图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

/** 历史记录也可能含网关 HTML，显示时沿用同一规则，不改写已保存的对话。 */
export function formatApiErrorMessage(message: string, status?: number): string {
  const text = message.trim()
  const html = /<(?:!doctype\s+html|html|head|body|title|h1)(?:\s|>)/i.test(text)
  const embeddedStatus = text.match(/\bHTTP\s+(502|503|504|524)\b|\b(502|503|504|524)\s+(?:Gateway|Bad Gateway|Service Unavailable)\b|\berror\s+code[:\s]+(502|503|504|524)\b/i)
  const gatewayStatus = status ?? Number(embeddedStatus?.[1] ?? embeddedStatus?.[2] ?? embeddedStatus?.[3])
  if ([502, 503, 504, 524].includes(gatewayStatus)) {
    const reason = gatewayStatus === 502 ? '接口网关连接上游失败'
      : gatewayStatus === 503 ? '接口服务暂时不可用' : '接口网关等待上游响应超时'
    const summary = `${reason}（HTTP ${gatewayStatus}）。`
    if (!html && text.startsWith(summary)) return text
    const detail = text && !html && !/^HTTP\s+\d+$/i.test(text) ? `\n服务商返回：${text}` : ''
    return `${summary}${detail}\n提示：请稍后重试，或减少同时请求数。网关的等待上限不受本机超时设置控制；原请求可能仍在服务端处理，重试前请先确认服务商任务状态。`
  }
  if (html) return `接口返回了错误页面${status ? `（HTTP ${status}）` : ''}，请检查 API 地址或稍后重试。`
  return text || (status ? `HTTP ${status}` : '接口请求失败，请稍后重试。')
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let text: string
  try {
    // 只读一次响应体，避免桌面流被 clone 后额外缓存整份错误页面。
    text = await response.text()
  } catch {
    return formatApiErrorMessage('', response.status)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return formatApiErrorMessage(text, response.status)
  }
  if (!payload || typeof payload !== 'object') return formatApiErrorMessage('', response.status)
  const record = payload as Record<string, unknown>
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null
  const message = typeof error?.message === 'string' ? error.message
    : typeof record.detail === 'string' ? record.detail
    : Array.isArray(record.detail) ? record.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    : typeof record.error === 'string' ? record.error
    : typeof record.message === 'string' ? record.message : ''
  return formatApiErrorMessage(message, response.status)
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' || record.quality === 'xhigh' || record.quality === 'max') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}
