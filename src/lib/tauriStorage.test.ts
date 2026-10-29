// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const onCloseRequested = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested }) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

// 模块内有加载状态和待写队列，每个用例重新加载一份
async function setup(stored: Record<string, string> = {}) {
  vi.resetModules()
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string) => (cmd === 'kv_get_all' ? stored : undefined))
  const mod = await import('./tauriStorage')
  await mod.loadTauriStorage()
  invoke.mockClear()
  return mod
}

describe('tauriStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('读取预加载的数据，并同步返回写入后的值', async () => {
    const { tauriStorage } = await setup({ a: '1' })
    expect(tauriStorage.getItem('a')).toBe('1')
    expect(tauriStorage.getItem('b')).toBeNull()
    tauriStorage.setItem('b', '2')
    expect(tauriStorage.getItem('b')).toBe('2')
    tauriStorage.removeItem('a')
    expect(tauriStorage.getItem('a')).toBeNull()
  })

  it('合并频繁写入，只写最终值', async () => {
    const { tauriStorage } = await setup()
    tauriStorage.setItem('k', '1')
    await vi.advanceTimersByTimeAsync(200)
    tauriStorage.setItem('k', '2')
    tauriStorage.setItem('k', '3')
    await vi.advanceTimersByTimeAsync(200)
    expect(invoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('kv_set', { key: 'k', value: '3' }, undefined)

    tauriStorage.removeItem('k')
    await vi.advanceTimersByTimeAsync(300)
    expect(invoke).toHaveBeenLastCalledWith('kv_remove', { key: 'k' }, undefined)
  })

  it('关闭窗口时先写完再返回', async () => {
    const { tauriStorage, installTauriStorageFlush } = await setup()
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.calls[0][0] as () => Promise<void>

    let release = () => {}
    invoke.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    tauriStorage.setItem('k', 'v')
    let closed = false
    const closing = handler().then(() => { closed = true })
    await Promise.resolve()
    // 先回执关闭请求，再写入
    expect(invoke).toHaveBeenNthCalledWith(1, 'close_ack')
    expect(invoke).toHaveBeenCalledWith('kv_set', { key: 'k', value: 'v' }, undefined)
    expect(closed).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)

    // 已写入后计时器不会再重复写
    await vi.advanceTimersByTimeAsync(300)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('关闭确认取消时阻止关闭且不写入，确认后写完再关', async () => {
    const { tauriStorage, installTauriStorageFlush, setTauriCloseGuard } = await setup()
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: { preventDefault: () => void }) => Promise<void>
    tauriStorage.setItem('k', 'v')

    setTauriCloseGuard(async () => false)
    const cancelled = { preventDefault: vi.fn() }
    await handler(cancelled)
    expect(cancelled.preventDefault).toHaveBeenCalled()
    // 等待确认前已回执，确认期间不会被 Rust 侧强制关闭；取消时不写入
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('close_ack')

    setTauriCloseGuard(async () => true)
    const confirmed = { preventDefault: vi.fn() }
    await handler(confirmed)
    expect(confirmed.preventDefault).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('kv_set', { key: 'k', value: 'v' }, undefined)
  })

  it('确认等待期间已发出回执', async () => {
    const { installTauriStorageFlush, setTauriCloseGuard } = await setup()
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: { preventDefault: () => void }) => Promise<void>
    let answer = (_: boolean) => {}
    setTauriCloseGuard(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const closing = handler({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('close_ack')
    answer(false)
    await closing
  })

  it('写入挂起时阻止关闭并保留持久提示，稍后落盘后提示自动清除', async () => {
    const { tauriStorage, installTauriStorageFlush } = await setup()
    const { getStorageSaveState } = await import('./storageSaveState')
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: { preventDefault: () => void }) => Promise<void>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release = () => {}
    invoke.mockImplementation((cmd: string) => (cmd === 'kv_set' ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()))
    tauriStorage.setItem('k', 'v')
    let handled = false
    const event = { preventDefault: vi.fn() }
    const closing = handler(event).then(() => { handled = true })
    await vi.advanceTimersByTimeAsync(2900)
    expect(handled).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await closing
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(getStorageSaveState()).toMatchObject({ pending: true, exitBlocked: expect.stringContaining('阻止退出') })
    expect(warn).toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
  })

  it('保存失败时拒绝退出，重试成功后才允许关闭', async () => {
    const { tauriStorage, installTauriStorageFlush } = await setup()
    const { getStorageSaveState } = await import('./storageSaveState')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: { preventDefault: () => void }) => Promise<void>
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'kv_set') throw { code: 'db', message: '磁盘已满，敏感内容不可显示' }
    })
    tauriStorage.setItem('k', '不可显示的配置内容')
    const failed = { preventDefault: vi.fn() }
    await handler(failed)
    expect(failed.preventDefault).toHaveBeenCalledOnce()
    expect(getStorageSaveState().issues).toHaveLength(1)
    expect(JSON.stringify(getStorageSaveState())).not.toContain('不可显示')

    invoke.mockResolvedValue(undefined)
    const retried = { preventDefault: vi.fn() }
    await handler(retried)
    expect(retried.preventDefault).not.toHaveBeenCalled()
    expect(getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
  })

  it('退出前同时等待对话和任务持久化，任一失败均拒绝退出', async () => {
    const { installTauriStorageFlush } = await setup()
    const { registerStorageSaveHandler, getStorageSaveState } = await import('./storageSaveState')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = vi.fn(async () => { throw new Error('模拟对话保存失败') })
    const tasks = vi.fn(async () => {})
    registerStorageSaveHandler('conversations', conversations)
    registerStorageSaveHandler('tasks', tasks)
    await installTauriStorageFlush()
    const handler = onCloseRequested.mock.lastCall?.[0] as (event: { preventDefault: () => void }) => Promise<void>
    const event = { preventDefault: vi.fn() }
    await handler(event)
    expect(conversations).toHaveBeenCalledOnce()
    expect(tasks).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(getStorageSaveState().issues[0].source).toBe('conversations')
  })

  it('退出等待期间产生的新设置也必须写完，旧写入完成不能提前关闭', async () => {
    const { tauriStorage, flushTauriStorageBeforeExit } = await setup()
    const { getStorageSaveState } = await import('./storageSaveState')
    let finishFirst = () => {}
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
    tauriStorage.setItem('k', '第一版')
    const saving = flushTauriStorageBeforeExit()
    await Promise.resolve()
    tauriStorage.setItem('k', '第二版')
    finishFirst()
    await saving
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('kv_set', { key: 'k', value: '第二版' }, undefined)
    expect(getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
  })

  it('部分设置写入失败不会被其他写入成功清除，重试只补写失败项', async () => {
    const { tauriStorage, flushTauriStorageBeforeExit } = await setup()
    const { getStorageSaveState } = await import('./storageSaveState')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValueOnce(new Error('模拟第一项写入失败'))
    tauriStorage.setItem('failed', 'v1')
    tauriStorage.setItem('saved', 'v2')
    await expect(flushTauriStorageBeforeExit()).rejects.toThrow('尚未全部保存')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(getStorageSaveState().issues).toHaveLength(1)
    await flushTauriStorageBeforeExit()
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenLastCalledWith('kv_set', { key: 'failed', value: 'v1' }, undefined)
    expect(getStorageSaveState()).toEqual({ issues: [], pending: false, exitBlocked: null })
  })

  it('页面隐藏时立即写入', async () => {
    const { tauriStorage, installTauriStorageFlush } = await setup()
    await installTauriStorageFlush()
    tauriStorage.setItem('k', 'v')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('kv_set', { key: 'k', value: 'v' }, undefined)
  })

  it('写入失败时记录错误，并在下一次写入时重试，不自动循环重试', async () => {
    const { tauriStorage, flushTauriStorage } = await setup()
    const { getStorageSaveState } = await import('./storageSaveState')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValueOnce({ code: 'db', message: 'disk full' })
    tauriStorage.setItem('k', '1')
    await flushTauriStorage()
    expect(error).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(getStorageSaveState().issues[0].source).toBe('settings')
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).toHaveBeenCalledTimes(1)

    // 例如关闭窗口时的那次写入
    await flushTauriStorage()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('kv_set', { key: 'k', value: '1' }, undefined)
    await flushTauriStorage()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(getStorageSaveState().issues).toEqual([])
  })

  it('值没变时跳过写入，也不推迟已有的防抖', async () => {
    const { tauriStorage } = await setup({ k: '1' })
    tauriStorage.setItem('k', '1')
    await vi.advanceTimersByTimeAsync(300)
    expect(invoke).not.toHaveBeenCalled()

    tauriStorage.setItem('k', '2')
    await vi.advanceTimersByTimeAsync(200)
    tauriStorage.setItem('k', '2')
    await vi.advanceTimersByTimeAsync(100)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('kv_set', { key: 'k', value: '2' }, undefined)
  })

  it('读取失败时不回写，避免默认值覆盖已有设置', async () => {
    vi.resetModules()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockReset()
    invoke.mockRejectedValueOnce({ code: 'unavailable', message: '数据目录不可写' })
    const mod = await import('./tauriStorage')
    await mod.loadTauriStorage()
    expect(mod.getTauriStorageLoadError()).toMatchObject({ code: 'unavailable', message: '数据目录不可写' })
    mod.tauriStorage.setItem('k', 'v')
    expect(mod.tauriStorage.getItem('k')).toBe('v')
    await mod.flushTauriStorage()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('store 加载时同步完成 hydration，修改后以相同的 key 和格式写回', async () => {
    const persisted = JSON.stringify({ state: { supportPromptDismissed: true, agentSidebarCollapsed: true }, version: 2 })
    // setup 已在导入 store 之前把 kv 读入内存，与 main.tsx 的启动顺序一致
    await setup({ 'gpt-image-playground': persisted })
    const { useStore } = await import('../store')
    expect(useStore.persist.hasHydrated()).toBe(true)
    expect(useStore.getState().supportPromptDismissed).toBe(true)
    expect(useStore.getState().agentSidebarCollapsed).toBe(true)

    useStore.setState({ agentSidebarCollapsed: false })
    await vi.advanceTimersByTimeAsync(300)
    const write = invoke.mock.calls.find(([cmd]) => cmd === 'kv_set')
    expect(write?.[1].key).toBe('gpt-image-playground')
    const saved = JSON.parse(write?.[1].value)
    expect(saved.version).toBe(2)
    expect(saved.state.agentSidebarCollapsed).toBe(false)
    expect(saved.state.supportPromptDismissed).toBe(true)
  })
})
