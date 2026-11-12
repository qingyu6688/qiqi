import { afterEach, describe, expect, it, vi } from 'vitest'
import { getImageRequestConcurrency, setImageRequestConcurrency, withImageCredentialSlot, withImageRequestSlot } from './imageRequestQueue'
import { settleWithConcurrency } from './batchPrompts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('全局生图请求队列', () => {
  afterEach(() => setImageRequestConcurrency(2))

  it('同一个 Key 保持单并发，其他 Key 可同时开始，取消等待不会提交', async () => {
    const gate = deferred()
    const abort = new AbortController()
    const first = vi.fn(() => gate.promise)
    const waiting = vi.fn(async () => '第二张')
    const other = vi.fn(async () => '另一个 Key')
    const active = withImageCredentialSlot('mock-key-a', first)
    const canceled = withImageCredentialSlot('mock-key-a', waiting, abort.signal)
    const rejection = expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    await expect(withImageCredentialSlot('mock-key-b', other)).resolves.toBe('另一个 Key')
    expect(first).toHaveBeenCalledOnce()
    expect(waiting).not.toHaveBeenCalled()
    abort.abort()
    await rejection
    gate.resolve()
    await active
    expect(waiting).not.toHaveBeenCalled()
    await expect(withImageCredentialSlot('mock-key-a', waiting)).resolves.toBe('第二张')
  })

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

  it('调高上限后立即放行排队请求，不限制时全部同时开始', async () => {
    const gate = deferred()
    let active = 0
    const running = Array.from({ length: 5 }, () => withImageRequestSlot(async () => {
      active += 1
      await gate.promise
      active -= 1
    }))
    await vi.waitFor(() => expect(active).toBe(2))
    setImageRequestConcurrency(4)
    await vi.waitFor(() => expect(active).toBe(4))
    setImageRequestConcurrency(Infinity)
    expect(getImageRequestConcurrency()).toBe(Infinity)
    await vi.waitFor(() => expect(active).toBe(5))
    gate.resolve()
    await Promise.all(running)
  })

  it('调低上限不打断已发出的请求，之后按新上限放行', async () => {
    setImageRequestConcurrency(3)
    const gates = [deferred(), deferred(), deferred()]
    let active = 0
    let peakAfterLowering = 0
    let lowered = false
    const run = (gate: Promise<void>) => withImageRequestSlot(async () => {
      active += 1
      if (lowered) peakAfterLowering = Math.max(peakAfterLowering, active)
      await gate
      active -= 1
    })
    const running = gates.map((gate) => run(gate.promise))
    await vi.waitFor(() => expect(active).toBe(3))
    setImageRequestConcurrency(1)
    lowered = true
    const queued = [run(Promise.resolve()), run(Promise.resolve())]
    gates[0].resolve()
    await running[0]
    expect(active).toBe(2)
    gates[1].resolve()
    gates[2].resolve()
    await Promise.all([...running, ...queued])
    expect(peakAfterLowering).toBe(1)
  })

  it('无效上限按 1 处理', () => {
    setImageRequestConcurrency(0)
    expect(getImageRequestConcurrency()).toBe(1)
    setImageRequestConcurrency(Number.NaN)
    expect(getImageRequestConcurrency()).toBe(1)
  })
})
