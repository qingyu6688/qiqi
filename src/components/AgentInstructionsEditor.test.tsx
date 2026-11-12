// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentInstructionsEditor from './AgentInstructionsEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('编辑后由保存按钮提交，等持久化成功才显示已保存', async () => {
  let finish: () => void = () => {}
  const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  act(() => root.render(<AgentInstructionsEditor title="对话设定" description="当前对话。" value="水彩" onSave={onSave} />))
  const input = container.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  蓝围巾白猫  ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onSave).not.toHaveBeenCalled()
  await act(async () => container.querySelector('button')!.click())
  expect(onSave).toHaveBeenCalledWith('蓝围巾白猫')
  expect(container.querySelector('button')!.disabled).toBe(true)
  expect(container.textContent).not.toContain('已保存')
  await act(async () => finish())
  expect(container.querySelector('[role="status"]')?.textContent).toBe('已保存，下轮生效')
})

it('保存失败保留输入并显示原因，可重新提交', async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error('磁盘已满')).mockResolvedValueOnce(undefined)
  act(() => root.render(<AgentInstructionsEditor title="对话设定" description="当前对话。" value="白猫" onSave={onSave} />))
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('磁盘已满')
  expect(container.querySelector('textarea')!.value).toBe('白猫')
  await act(async () => container.querySelector('button')!.click())
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('已保存')
})
