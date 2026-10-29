// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../types'
import { createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import { fetchAvailableModels } from '../../api/models'
import { isPresetAgentFieldLocked } from '../../lib/presetConfig'
import TextApiSettingsTab from './TextApiSettingsTab'

vi.mock('../../api/models', () => ({ fetchAvailableModels: vi.fn() }))
vi.mock('../../lib/presetConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/presetConfig')>(),
  isPresetAgentFieldLocked: vi.fn(() => false),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let saved: AppSettings
const openConversation = vi.fn()
const imageProfile = createDefaultOpenAIProfile({ id: 'image', name: '我的图像接口', apiKey: 'mock-image-key', model: 'image-selected' })
const textProfile = createDefaultOpenAIProfile({ id: 'text', name: '我的文本接口', apiMode: 'responses', apiKey: 'mock-text-key', model: 'text-old' })

function Harness({ initial }: { initial: AppSettings }) {
  const [draft, setDraft] = useState(initial)
  saved = draft
  return <TextApiSettingsTab draft={draft} onDraftChange={setDraft} commitSettings={(next) => setDraft(normalizeSettings(next))} onOpenConversationSettings={openConversation} />
}

async function render(withText = true): Promise<void> {
  const initial = normalizeSettings({ profiles: withText ? [imageProfile, textProfile] : [imageProfile], activeProfileId: imageProfile.id })
  await act(async () => root.render(<Harness initial={initial} />))
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isPresetAgentFieldLocked).mockReturnValue(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('独立文本 API 配置', () => {
  it('没有文本配置时显示入口，添加配置不会切换或覆盖画廊接口', async () => {
    await render(false)
    expect(container.textContent).toContain('尚未配置文本 API')
    await click('添加文本 API')
    expect(saved.activeProfileId).toBe('image')
    expect(saved.profiles.find((item) => item.id === 'image')).toEqual(imageProfile)
    expect(saved.profiles).toHaveLength(2)
    expect(saved.profiles[1]).toMatchObject({ apiMode: 'responses', apiKey: '', provider: 'openai' })
    expect(container.querySelector('input[aria-label="文本 API Key"]')?.getAttribute('type')).toBe('password')
  })

  it('使用文本 Key 读取模型并保存，保留图像配置和选中模型', async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue([{ id: 'text-new' }])
    await render()
    await click('读取模型')
    expect(fetchAvailableModels).toHaveBeenCalledWith(textProfile, expect.any(AbortSignal))
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="text-new"]')!.click())
    expect(saved.profiles.find((item) => item.id === 'text')).toMatchObject({ model: 'text-new', selectedModel: 'text-new' })
    expect(saved.profiles.find((item) => item.id === 'image')).toEqual(imageProfile)
    expect(saved.activeProfileId).toBe('image')
    expect(container.textContent).not.toContain('原生工具的图像模型')
  })

  it('一键关联使用混合模式，文本与图像 Key 各自保留', async () => {
    await render()
    await click('用于对话生图')
    expect(saved).toMatchObject({ activeProfileId: 'image', agentApiConfigMode: 'hybrid', agentTextProfileId: 'text', agentImageProfileId: 'image' })
    expect(saved.profiles.map((item) => item.apiKey)).toEqual(['mock-image-key', 'mock-text-key'])
    expect(container.textContent).toContain('已用于对话生图')
    await click('打开对话生图配置，调整模式与图像 API')
    expect(openConversation).toHaveBeenCalledOnce()
  })

  it('缺少 Key 或部署锁定时不能关联对话 API', async () => {
    await render(false)
    await click('添加文本 API')
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '用于对话生图')!
    expect(button.disabled).toBe(true)
    vi.mocked(isPresetAgentFieldLocked).mockReturnValue(true)
    await act(async () => root.render(<Harness initial={saved} />))
    expect(container.textContent).toContain('对话 API 关联由部署配置锁定')
    expect(saved.agentApiConfigMode).toBe('off')
  })
})
