import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('本地持久化队列', () => {
  beforeEach(() => vi.resetModules())

  it('合并尚未开始的同一记录快照，全部调用等待最新值落盘', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    const { getStorageSaveState } = await import('./storageSaveState')
    const save = vi.fn(async (_value: number) => {})
    const queue = createStorageWriteQueue('tasks', save)
    const first = queue.enqueue('task', 1)
    const second = queue.enqueue('task', 2)
    const third = queue.enqueue('task', 3)
    expect(getStorageSaveState().pending).toBe(true)
    await Promise.all([first, second, third, queue.flush()])
    expect(save.mock.calls.map(([value]) => value)).toEqual([3])
    expect(getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
    await queue.flush()
    expect(save).toHaveBeenCalledOnce()
  })

  it('写入中产生的新快照串行保存，持续更新的记录不阻挡其他记录', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    let finishFirst = () => {}
    let active = 0
    let peak = 0
    const save = vi.fn(async (value: string) => {
      active++
      peak = Math.max(peak, active)
      if (value === 'a1') await new Promise<void>((resolve) => { finishFirst = resolve })
      active--
    })
    const queue = createStorageWriteQueue('tasks', save)
    const first = queue.enqueue('a', 'a1')
    await Promise.resolve()
    const second = queue.enqueue('a', 'a2')
    const other = queue.enqueue('b', 'b1')
    const third = queue.enqueue('a', 'a3')
    expect(save.mock.calls.map(([value]) => value)).toEqual(['a1'])
    finishFirst()
    await Promise.all([first, second, other, third, queue.flush()])
    expect(save.mock.calls.map(([value]) => value)).toEqual(['a1', 'b1', 'a3'])
    expect(peak).toBe(1)
  })

  it('失败快照保留供手动重试，失败期间阻止退出，恢复后清除提示', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    const state = await import('./storageSaveState')
    const save = vi.fn(async (_value: string): Promise<void> => { throw new Error('模拟磁盘写入失败') })
    const queue = createStorageWriteQueue('conversations', save)
    await expect(queue.enqueue('all', '对话最新内容')).rejects.toThrow('模拟磁盘写入失败')
    expect(state.getStorageSaveState()).toMatchObject({ pending: true, issues: [{ source: 'conversations' }] })
    expect(save).toHaveBeenCalledOnce()
    await expect(state.flushRegisteredStorageSaves()).rejects.toThrow('尚未全部保存')
    expect(save).toHaveBeenCalledTimes(2)
    state.setStorageExitBlocked('已阻止退出')

    save.mockResolvedValue(undefined)
    await state.flushRegisteredStorageSaves()
    expect(save.mock.calls.map(([value]) => value)).toEqual(['对话最新内容', '对话最新内容', '对话最新内容'])
    expect(state.getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
  })

  it('后续记录写入失败不会把已保存记录的调用也判为失败', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    const save = vi.fn(async (value: string) => {
      if (value === 'b') throw new Error('第二个任务写入失败')
    })
    const queue = createStorageWriteQueue('tasks', save)
    const saved = queue.enqueue('a', 'a')
    const failed = expect(queue.enqueue('b', 'b')).rejects.toThrow('第二个任务写入失败')
    await expect(saved).resolves.toBeUndefined()
    await failed
    save.mockResolvedValue(undefined)
    await queue.flush()
    expect(save.mock.calls.map(([value]) => value)).toEqual(['a', 'b', 'b'])
  })

  it('较旧写入失败后只重试最新快照，待写调用均收到错误而不会一直挂起', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    let failFirst = (_err: Error) => {}
    const save = vi.fn(async (_value: number) => {})
    save.mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject }))
    const queue = createStorageWriteQueue('tasks', save)
    const first = expect(queue.enqueue('a', 1)).rejects.toThrow('失败')
    await Promise.resolve()
    const newer = expect(queue.enqueue('a', 2)).rejects.toThrow('失败')
    const other = expect(queue.enqueue('b', 3)).rejects.toThrow('失败')
    failFirst(new Error('失败'))
    await Promise.all([first, newer, other])
    expect(save.mock.calls.map(([value]) => value)).toEqual([1])
    await queue.flush()
    expect(save.mock.calls.map(([value]) => value)).toEqual([1, 2, 3])
  })

  it('同值再次入队可共享正在进行的写入，退出仍等待真实落盘', async () => {
    const { createStorageWriteQueue } = await import('./storageWriteQueue')
    const { flushRegisteredStorageSaves } = await import('./storageSaveState')
    let finish = () => {}
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const queue = createStorageWriteQueue<number>('tasks', save)
    const first = queue.enqueue('a', 1)
    await Promise.resolve()
    const second = queue.enqueue('a', 1)
    let flushed = false
    const exit = flushRegisteredStorageSaves().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    finish()
    await Promise.all([first, second, exit])
    expect(flushed).toBe(true)
    expect(save).toHaveBeenCalledOnce()
  })
})
