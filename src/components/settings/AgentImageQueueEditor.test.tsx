// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiProfile, AppSettings } from '../../types'
import { fetchAvailableModels } from '../../api/models'
import { createDefaultOpenAIProfile, getAgentImageApiProfile, getAgentImageQueueProfiles, normalizeSettings } from '../../lib/apiProfiles'
import AgentImageQueueEditor from './AgentImageQueueEditor'

vi.mock('../../api/models', () => ({ fetchAvailableModels: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const endpoint = 'https://images.example.test/v1'
const exampleKeys = Array.from({ length: 5 }, (_, index) => `mock-key-${index + 1}`)
const gallery = createDefaultOpenAIProfile({ id: 'gallery', baseUrl: endpoint, apiKey: exampleKeys[0], model: 'common-image' })
const text = createDefaultOpenAIProfile({ id: 'text', apiMode: 'responses', apiKey: 'mock-text', model: 'text-model' })
const saved = vi.fn<(settings: AppSettings) => Promise<void>>()
let root: Root
let container: HTMLDivElement

function Harness({ primary }: { primary: ApiProfile | null }) {
  const [draft, setDraft] = useState(() => normalizeSettings({
    profiles: [gallery, text], activeProfileId: gallery.id, agentTextProfileId: text.id, agentImageProfileId: gallery.id,
  }))
  return <AgentImageQueueEditor draft={draft} primary={primary} onSave={async (settings) => {
    await saved(settings)
    setDraft(normalizeSettings(settings))
  }} />
}

const addressInput = () => container.querySelector<HTMLInputElement>('input[type="url"]')!
const keyInputs = () => [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')]
const button = (label: string) => [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)!
const click = (label: string) => act(async () => button(label).click())
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

function paste(keys: string[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => keys.join('\r\n') } })
  act(() => keyInputs()[0].dispatchEvent(event))
}

beforeEach(() => {
  vi.mocked(fetchAvailableModels).mockReset()
  saved.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('同一页粘贴五个 Key，读出共同模型后一次保存并启用有序队列', async () => {
  vi.mocked(fetchAvailableModels).mockImplementation(async ({ apiKey }) => [{ id: 'common-image' }, { id: `private-${apiKey}` }])
  act(() => root.render(<Harness primary={null} />))
  expect(keyInputs()).toHaveLength(5)
  expect(button('保存').disabled).toBe(true)
  paste(exampleKeys)
  type(addressInput(), endpoint)
  expect(keyInputs().map((input) => input.value)).toEqual(exampleKeys)
  expect(saved).not.toHaveBeenCalled()
  await click('读取模型')
  expect(vi.mocked(fetchAvailableModels).mock.calls.map(([profile]) => profile)).toEqual(exampleKeys.map((apiKey) => ({ baseUrl: endpoint, apiKey, apiProxy: false })))
  expect(saved).not.toHaveBeenCalled()
  expect(container.querySelector('[role="combobox"]')?.textContent).toBe('common-image')

  let finishSave = () => {}
  saved.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve }))
  await click('保存')
  expect(button('正在保存…')).toBeDefined()
  expect(container.textContent).not.toContain('已保存 5 个 Key')
  await act(async () => finishSave())
  expect(container.textContent).toContain('已保存 5 个 Key')

  const next = saved.mock.calls[0][0]
  expect(next).toMatchObject({ activeProfileId: gallery.id, agentTextProfileId: text.id, agentImageProfileId: gallery.id, agentApiConfigMode: 'hybrid' })
  expect(next.profiles.slice(0, 2)).toEqual([gallery, text])
  expect(next.profiles).toHaveLength(6)
  expect(getAgentImageQueueProfiles(next, getAgentImageApiProfile(next)!).map((profile) => profile.apiKey)).toEqual(exampleKeys)
  await click('保存')
  expect(saved.mock.calls[1][0].profiles.map((profile) => profile.id)).toEqual(next.profiles.map((profile) => profile.id))
})

it('报告没有权限的 Key，重复 Key 不会发出读取请求', async () => {
  vi.mocked(fetchAvailableModels).mockImplementation(async ({ apiKey }) => {
    if (apiKey === exampleKeys[1]) throw new Error('当前 Key 没有读取模型的权限')
    return [{ id: 'common-image' }]
  })
  act(() => root.render(<Harness primary={null} />))
  type(addressInput(), endpoint)
  paste([exampleKeys[0], exampleKeys[0]])
  await click('读取模型')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('第 2 个 Key 重复')
  expect(fetchAvailableModels).not.toHaveBeenCalled()
  paste(exampleKeys)
  await click('读取模型')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('第 2 个 Key：当前 Key 没有读取模型的权限')
  expect(button('保存').disabled).toBe(true)
  expect(saved).not.toHaveBeenCalled()
})

it('更换地址后移除带入的 Key，读取中换 Key 会取消并丢弃旧结果', async () => {
  act(() => root.render(<Harness primary={gallery} />))
  expect(keyInputs()[0].value).toBe(gallery.apiKey)
  type(addressInput(), 'https://other.example.test/v1')
  expect(keyInputs()[0].value).toBe('')
  type(keyInputs()[0], exampleKeys[2])
  let finish = (_: Array<{ id: string }>) => {}
  vi.mocked(fetchAvailableModels).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  await click('读取模型')
  type(keyInputs()[0], exampleKeys[3])
  expect(vi.mocked(fetchAvailableModels).mock.calls[0][1]?.aborted).toBe(true)
  await act(async () => finish([{ id: 'old-model' }]))
  expect(container.textContent).not.toContain('old-model')
  expect(button('保存').disabled).toBe(true)
})

it('保存失败时保留输入并可再次保存', async () => {
  saved.mockRejectedValueOnce(new Error('设置尚未保存，请重试。'))
  vi.mocked(fetchAvailableModels).mockResolvedValue([{ id: 'common-image' }])
  act(() => root.render(<Harness primary={gallery} />))
  await click('读取模型')
  await click('保存')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('设置尚未保存')
  expect(keyInputs()[0].value).toBe(gallery.apiKey)
  await click('保存')
  expect(container.textContent).toContain('已保存 1 个 Key')
})
