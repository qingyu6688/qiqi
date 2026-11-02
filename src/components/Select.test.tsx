// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Select from './Select'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const changed = vi.fn()
const options = [{ label: '自动（最多10张）', value: 'auto' }, ...Array.from({ length: 10 }, (_, i) => ({ label: `${i + 1} 张`, value: i + 1 }))]
const trigger = () => container.querySelector<HTMLElement>('[role="combobox"]')!
const key = (value: string) => act(() => trigger().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('鼠标展开后显示选中项，选择关闭并保留焦点，外部点击可关闭', () => {
  act(() => root.render(<Select value={4} options={options} onChange={changed} ariaLabel="对话生图数量" />))
  act(() => trigger().click())
  expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe('4 张')
  const option = container.querySelector<HTMLElement>('[data-option-value="10"]')!
  act(() => option.click())
  expect(changed).toHaveBeenCalledWith(10)
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger())
  act(() => trigger().click())
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(container.querySelector('[role="listbox"]')).toBeNull()
})

it('键盘从当前数量展开，方向键移动、回车提交，激活项与可访问属性一致', () => {
  act(() => root.render(<Select value={4} options={options} onChange={changed} ariaLabel="对话生图数量" />))
  trigger().focus()
  key('ArrowDown')
  expect(document.getElementById(trigger().getAttribute('aria-activedescendant')!)?.textContent).toBe('4 张')
  key('ArrowDown')
  expect(document.getElementById(trigger().getAttribute('aria-activedescendant')!)?.textContent).toBe('5 张')
  key('Enter')
  expect(changed).toHaveBeenCalledWith(5)
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
})

it('Home、End 支持选择数量两端，Escape 和 Tab 关闭但不提交', () => {
  act(() => root.render(<Select value={4} options={options} onChange={changed} />))
  key('End')
  key(' ')
  expect(changed).toHaveBeenLastCalledWith(10)
  key('Home')
  key('Enter')
  expect(changed).toHaveBeenLastCalledWith('auto')
  changed.mockClear()
  key('Enter')
  key('Escape')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  key(' ')
  key('Tab')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

it('禁用状态无法用鼠标或键盘展开', () => {
  act(() => root.render(<Select value="auto" options={options} onChange={changed} disabled />))
  act(() => trigger().click())
  key('Enter')
  expect(trigger().tabIndex).toBe(-1)
  expect(trigger().getAttribute('aria-disabled')).toBe('true')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})
