// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProfile } from '../../types'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import { fetchAvailableModels } from '../../api/models'
import ApiModelPicker from './ApiModelPicker'

vi.mock('../../api/models', () => ({ fetchAvailableModels: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const changed = vi.fn()
const profile = createDefaultOpenAIProfile({ provider: 'sb2api-async', baseUrl: 'https://sub2api.example.com/v1', apiKey: 'test-key', model: 'legacy-model' })

async function render(current: ApiProfile = profile) {
  await act(async () => root.render(<ApiModelPicker profile={current} disabled={false} onChange={changed} />))
}
async function clickRead() {
  const button = container.querySelector('button')!
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('sub2api 模型选择', () => {
  it('读取前不要求填写模型，读取后可勾选权限内模型', async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue([{ id: 'image-a' }, { id: 'image-b' }])
    await render()
    expect(container.querySelector('input')).toBeNull()
    await clickRead()
    expect(fetchAvailableModels).toHaveBeenCalledWith(profile, expect.any(AbortSignal))
    expect(container.textContent).toContain('不在当前 Key 的列表')
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="image-b"]')!
    await act(async () => checkbox.click())
    expect(changed).toHaveBeenCalledWith({ model: 'image-b', selectedModel: 'image-b' })
  })

  it('切换 Key 后清除旧列表，不显示迟到的旧 Key 响应', async () => {
    let finish: ((value: { id: string }[]) => void) | undefined
    vi.mocked(fetchAvailableModels).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await render()
    await clickRead()
    await render({ ...profile, apiKey: 'another-key' })
    await act(async () => finish?.([{ id: 'old-key-private-model' }]))
    expect(container.textContent).not.toContain('old-key-private-model')
    expect(container.textContent).toContain('读取模型')
    expect(changed).not.toHaveBeenCalled()
  })

  it('无权限模型和读取失败都有明确状态，可以重试', async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Key 无效'))
    await render()
    await clickRead()
    expect(container.textContent).toContain('当前 Key 未返回可用模型')
    await clickRead()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Key 无效')
    expect(container.querySelector('button')?.disabled).toBe(false)
  })
})
