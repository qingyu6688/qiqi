import { IMAGE_REQUEST_CONCURRENCY } from './batchPrompts'

interface RequestSlotOptions {
  signal?: AbortSignal
  onRequestStarted?: () => void
}

interface WaitingRequest {
  start: () => void
}

let activeRequests = 0
let concurrencyLimit = IMAGE_REQUEST_CONCURRENCY
const waitingRequests: WaitingRequest[] = []

export function getImageRequestConcurrency() {
  return concurrencyLimit
}

/** 设置所有生图入口共用的同时请求数，Infinity 表示不限制。调高后立即放行排队中的请求，调低时已发出的请求不受影响 */
export function setImageRequestConcurrency(limit: number) {
  concurrencyLimit = limit >= 1 ? Math.floor(limit) : 1
  while (activeRequests < concurrencyLimit && waitingRequests.length) waitingRequests.shift()!.start()
}

/** 所有生图入口共用队列；拿到名额后才启动请求超时，取消排队不会发送请求。 */
export async function withImageRequestSlot<T>(worker: () => Promise<T>, options: RequestSlotOptions = {}): Promise<T> {
  const signal = options.signal
  const abortError = () => signal?.reason ?? new DOMException('请求已停止', 'AbortError')
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const index = waitingRequests.indexOf(entry)
      if (index < 0) return
      waitingRequests.splice(index, 1)
      signal?.removeEventListener('abort', cancel)
      reject(abortError())
    }
    const entry: WaitingRequest = {
      start: () => {
        signal?.removeEventListener('abort', cancel)
        activeRequests += 1
        resolve()
      },
    }
    if (activeRequests < concurrencyLimit) entry.start()
    else {
      waitingRequests.push(entry)
      signal?.addEventListener('abort', cancel, { once: true })
    }
  })
  try {
    if (signal?.aborted) throw abortError()
    options.onRequestStarted?.()
    return await worker()
  } finally {
    activeRequests -= 1
    if (activeRequests < concurrencyLimit) waitingRequests.shift()?.start()
  }
}
