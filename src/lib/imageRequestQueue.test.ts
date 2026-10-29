import { describe, expect, it, vi } from 'vitest'
import { withImageRequestSlot } from './imageRequestQueue'
import { settleWithConcurrency } from './batchPrompts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('全局生图请求队列', () => {
  it('多批请求共享两个名额，保持各批返回顺序', async () => {
    let active = 0
    let peak = 0
    const worker = (id: number) => withImageRequestSlot(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return id
    })
    const batches = await Promise.all([
      settleWithConcurrency([1, 2, 3, 4], 2, worker),
      settleWithConcurrency([5, 6, 7, 8], 2, worker),
    ])
    expect(peak).toBe(2)
    expect(batches.flat().map((result) => result.status === 'fulfilled' ? result.value : null)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('取消排队项不发送请求，其他排队项仍能开始', async () => {
    const gate = deferred()
    const running = [withImageRequestSlot(() => gate.promise), withImageRequestSlot(() => gate.promise)]
    const abort = new AbortController()
    const canceledWorker = vi.fn(async () => 1)
    const canceled = withImageRequestSlot(canceledWorker, { signal: abort.signal })
    const rejection = expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    const nextWorker = vi.fn(async () => 2)
    const next = withImageRequestSlot(nextWorker)
    abort.abort()
    await rejection
    expect(canceledWorker).not.toHaveBeenCalled()
    expect(nextWorker).not.toHaveBeenCalled()
    gate.resolve()
    await Promise.all(running)
    await expect(next).resolves.toBe(2)
  })

  it('轮到请求后才通知开始，失败也释放名额', async () => {
    const gate = deferred()
    const running = [withImageRequestSlot(() => gate.promise), withImageRequestSlot(() => gate.promise)]
    const onRequestStarted = vi.fn()
    const queued = withImageRequestSlot(async () => { throw new Error('模拟失败') }, { onRequestStarted })
    const rejection = expect(queued).rejects.toThrow('模拟失败')
    expect(onRequestStarted).not.toHaveBeenCalled()
    gate.resolve()
    await Promise.all(running)
    await rejection
    expect(onRequestStarted).toHaveBeenCalledOnce()
    await expect(withImageRequestSlot(async () => '下一张')).resolves.toBe('下一张')
  })
})
