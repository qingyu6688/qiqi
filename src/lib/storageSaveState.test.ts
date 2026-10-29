import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('本地保存状态协调', () => {
  beforeEach(() => vi.resetModules())

  it('同来源错误只展示一次，恢复一个来源不会掩盖其他失败', async () => {
    const state = await import('./storageSaveState')
    const listener = vi.fn()
    const unsubscribe = state.subscribeStorageSaveState(listener)
    state.reportStorageSaveFailure('settings')
    state.reportStorageSaveFailure('settings')
    state.reportStorageSaveFailure('tasks')
    expect(listener).toHaveBeenCalledTimes(2)
    state.clearStorageSaveFailure('settings')
    expect(state.getStorageSaveState().issues.map((issue) => issue.source)).toEqual(['tasks'])
    unsubscribe()
    state.clearStorageSaveFailure('tasks')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('所有来源均完成后才能继续退出，失败不打断其他保存', async () => {
    const state = await import('./storageSaveState')
    let finishTasks = () => {}
    const tasks = vi.fn(() => new Promise<void>((resolve) => { finishTasks = resolve }))
    state.registerStorageSaveHandler('settings', async () => { throw new Error('模拟保存失败') })
    state.registerStorageSaveHandler('tasks', tasks)
    let finished = false
    const saved = state.flushRegisteredStorageSaves().finally(() => { finished = true })
    const result = expect(saved).rejects.toThrow('尚未全部保存')
    await Promise.resolve()
    expect(finished).toBe(false)
    finishTasks()
    await result
    expect(state.getStorageSaveState().issues[0].source).toBe('settings')
  })

  it('仍有待保存内容时拒绝退出，落盘后清除超时提示', async () => {
    const state = await import('./storageSaveState')
    state.setStorageSavePending('tasks', true)
    state.setStorageExitBlocked('保存超时')
    await expect(state.flushRegisteredStorageSaves()).rejects.toThrow('尚未全部保存')
    expect(state.getStorageSaveState().exitBlocked).toBe('保存超时')
    state.setStorageSavePending('tasks', false)
    expect(state.getStorageSaveState().exitBlocked).toBeNull()
    await expect(state.flushRegisteredStorageSaves()).resolves.toBeUndefined()
  })
})
