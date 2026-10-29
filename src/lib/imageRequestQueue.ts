import { IMAGE_REQUEST_CONCURRENCY } from './batchPrompts'

interface RequestSlotOptions {
  signal?: AbortSignal
  onRequestStarted?: () => void
}

interface WaitingRequest {
  start: () => void
}

let activeRequests = 0
const waitingRequests: WaitingRequest[] = []

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
    if (activeRequests < IMAGE_REQUEST_CONCURRENCY) entry.start()
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
    waitingRequests.shift()?.start()
  }
}
