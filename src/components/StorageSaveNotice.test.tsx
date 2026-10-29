// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearStorageSaveFailure, reportStorageSaveFailure, setStorageExitBlocked, setStorageSavePending } from '../lib/storageSaveState'
import StorageSaveNotice from './StorageSaveNotice'

const flush = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../lib/tauriStorage', () => ({ flushTauriStorageBeforeExit: flush }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  flush.mockReset()
  flush.mockResolvedValue(undefined)
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  for (const source of ['settings', 'tasks', 'conversations'] as const) {
    clearStorageSaveFailure(source)
    setStorageSavePending(source, false)
  }
  setStorageExitBlocked(null)
  vi.restoreAllMocks()
})

it('保存失败时持续展示错误与重试，只有持久化恢复后收起', async () => {
  await act(async () => root.render(<StorageSaveNotice />))
  expect(container.querySelector('[role="alert"]')).toBeNull()
  act(() => reportStorageSaveFailure('settings'))
  expect(container.textContent).toContain('API 配置')
  const button = container.querySelector('button')!
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  flush.mockRejectedValueOnce(new Error('模拟磁盘写入失败'))
  await act(async () => button.click())
  expect(flush).toHaveBeenCalledOnce()
  expect(button.disabled).toBe(false)
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  flush.mockImplementationOnce(async () => clearStorageSaveFailure('settings'))
  await act(async () => button.click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('单次写入挂起时也显示退出已阻止，并允许继续等待保存', async () => {
  setStorageSavePending('tasks', true)
  setStorageExitBlocked('本地数据保存仍未完成，已阻止退出或安装。')
  await act(async () => root.render(<StorageSaveNotice />))
  expect(container.textContent).toContain('已阻止退出或安装')
  let finish = () => {}
  flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('button')?.disabled).toBe(true)
  expect(container.textContent).toContain('正在等待保存')
  await act(async () => {
    setStorageSavePending('tasks', false)
    finish()
  })
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
