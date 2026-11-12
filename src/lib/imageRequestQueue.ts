import { IMAGE_REQUEST_CONCURRENCY } from './batchPrompts'

interface RequestSlotOptions {
  signal?: AbortSignal
  onRequestStarted?: () => void
}

interface WaitingRequest {
  start: () => void
}

interface RequestQueue {
  active: number
  limit: number
  waiting: WaitingRequest[]
}

const imageQueue: RequestQueue = { active: 0, limit: IMAGE_REQUEST_CONCURRENCY, waiting: [] }
const credentialQueues = new Map<string, RequestQueue>()

export function getImageRequestConcurrency() {
  return imageQueue.limit
}

/** 设置所有生图入口共用的同时请求数，Infinity 表示不限制。调高后立即放行排队中的请求，调低时已发出的请求不受影响 */
export function setImageRequestConcurrency(limit: number) {
  imageQueue.limit = limit >= 1 ? Math.floor(limit) : 1
  while (imageQueue.active < imageQueue.limit && imageQueue.waiting.length) imageQueue.waiting.shift()?.start()
}

/** 所有生图入口共用队列；拿到名额后才启动请求超时，取消排队不会发送请求。 */
export function withImageRequestSlot<T>(worker: () => Promise<T>, options: RequestSlotOptions = {}): Promise<T> {
  return withRequestSlot(imageQueue, worker, options)
}

/** 多 Key 队列同一密钥只发送一张。先等密钥名额，再由实际生图请求获取全局名额。 */
export async function withImageCredentialSlot<T>(key: string, worker: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const credential = key.trim()
  const queue = credentialQueues.get(credential) ?? { active: 0, limit: 1, waiting: [] }
  credentialQueues.set(credential, queue)
  try {
    return await withRequestSlot(queue, worker, { signal })
  } finally {
    if (!queue.active && !queue.waiting.length && credentialQueues.get(credential) === queue) credentialQueues.delete(credential)
  }
}

async function withRequestSlot<T>(queue: RequestQueue, worker: () => Promise<T>, options: RequestSlotOptions): Promise<T> {
  const signal = options.signal
  const abortError = () => signal?.reason ?? new DOMException('请求已停止', 'AbortError')
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const index = queue.waiting.indexOf(entry)
      if (index < 0) return
      queue.waiting.splice(index, 1)
      signal?.removeEventListener('abort', cancel)
      reject(abortError())
    }
    const entry: WaitingRequest = {
      start: () => {
        signal?.removeEventListener('abort', cancel)
        queue.active += 1
        resolve()
      },
    }
    if (queue.active < queue.limit) entry.start()
    else {
      queue.waiting.push(entry)
      signal?.addEventListener('abort', cancel, { once: true })
    }
  })
  try {
    if (signal?.aborted) throw abortError()
    options.onRequestStarted?.()
    return await worker()
  } finally {
    queue.active -= 1
    if (queue.active < queue.limit) queue.waiting.shift()?.start()
  }
}
