// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../../types'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import InputParamsPanel from './inputParamsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const countChanged = vi.fn()
const noop = () => {}
const hint = { visible: false, show: noop, hide: noop, clearTimer: noop, startTouch: noop }
const props: ComponentProps<typeof InputParamsPanel> = {
  params: DEFAULT_PARAMS, setParams: noop,
  activeProfile: createDefaultOpenAIProfile({ model: 'gpt-image-2' }),
  modelOptions: [{ label: 'gpt-image-2', value: 'gpt-image-2' }], onModelChange: noop,
  isFalProvider: false, isFalTextToImage: false, displaySize: 'auto',
  qualityOptions: [{ label: 'auto', value: 'auto' }, { label: 'high', value: 'high' }], selectClass: '',
  transparentOutputAvailable: false, showTransparentOutputControl: false, transparentOutputEnabled: false,
  transparentOutputHint: hint, onTransparentOutputMenuOpenChange: noop,
  compressionHint: hint, compressionDisabled: true, outputCompressionInput: '', setOutputCompressionInput: noop,
  commitOutputCompression: noop, moderationHint: hint, moderationDisabled: false,
  agentAutoImageCount: true, agentMode: true, agentImageCount: 'auto', onAgentImageCountChange: countChanged,
  outputImageLimit: 10, nInput: '1', setNInputFocused: noop, commitN: noop, handleNInputChange: noop,
  handleNLimitIncreaseAttempt: noop, showAgentNHint: noop, hideNLimitHint: noop,
  startAgentNHintTouch: noop, clearAgentNHintTouchTimer: noop, nLimitHint: hint, nLimitHintText: '',
  streamConcurrentByN: false, streamConcurrentHint: hint, sizeHint: hint, qualityHint: hint, onOpenSizePicker: noop,
  showBatch: false, batchEnabled: false, batchMode: 'queue', batchConcurrencyLimited: true, batchConcurrency: 10,
  batchPromptCount: 0, batchProgress: null, onBatchChange: noop, onStopBatch: noop,
}

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

it('对话数量使用统一浮层，保留自动和 1–10 张，并按正确类型保存', () => {
  act(() => root.render(<InputParamsPanel {...props} />))
  const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="对话生图数量"]')!
  expect(container.querySelector('select')).toBeNull()
  expect(trigger.textContent).toContain('自动（最多10张）')
  act(() => trigger.click())
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(11)
  act(() => container.querySelector<HTMLElement>('[data-option-value="10"]')!.click())
  expect(countChanged).toHaveBeenLastCalledWith(10)
  act(() => root.render(<InputParamsPanel {...props} agentImageCount={10} />))
  expect(trigger.textContent).toContain('10 张')
  act(() => trigger.click())
  act(() => container.querySelector<HTMLElement>('[data-option-value="auto"]')!.click())
  expect(countChanged).toHaveBeenLastCalledWith('auto')
})

it('画廊仍使用原数量输入框，互不改变数量配置', () => {
  act(() => root.render(<InputParamsPanel {...props} agentMode={false} agentAutoImageCount={false} />))
  expect(container.querySelector('[aria-label="对话生图数量"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1')
  expect(countChanged).not.toHaveBeenCalled()
})
