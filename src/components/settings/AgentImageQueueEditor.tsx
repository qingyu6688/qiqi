import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { MAX_AGENT_IMAGES_PER_ROUND, type ApiProfile, type AppSettings } from '../../types'
import type { AvailableModel } from '../../types/models'
import { fetchAvailableModels } from '../../api/models'
import { createAgentImageQueueSettings, getAgentImageQueueSetup, validateAgentImageQueueSetup } from '../../lib/agentImageQueueSetup'
import { settleWithConcurrency } from '../../lib/batchPrompts'
import Select from '../Select'

const INPUT_CLASS = 'w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-200'
const MODEL_READ_CONCURRENCY = 2

interface AgentImageQueueEditorProps {
  draft: AppSettings
  primary: ApiProfile | null
  onSave: (settings: AppSettings) => Promise<void>
}

export default function AgentImageQueueEditor({ draft, primary, onSave }: AgentImageQueueEditorProps) {
  const [initial] = useState(() => getAgentImageQueueSetup(draft, primary))
  const [address, setAddress] = useState(initial.baseUrl)
  const [keys, setKeys] = useState(initial.keys)
  const [models, setModels] = useState<AvailableModel[]>([])
  const [model, setModel] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const boundKeysRef = useRef({ address: initial.baseUrl, keys: new Set(initial.keys.map((key) => key.trim()).filter(Boolean)) })

  useEffect(() => () => controllerRef.current?.abort(), [])

  const invalidateModels = (): void => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setReading(false)
    setModels([])
    setModel('')
    setErrors([])
    setNotice('')
  }

  const pasteKeys = (event: ClipboardEvent<HTMLInputElement>, index: number): void => {
    const text = event.clipboardData.getData('text')
    if (!/[\r\n]/.test(text)) return
    event.preventDefault()
    const pasted = text.split(/\r?\n|\r/).map((key) => key.trim()).filter(Boolean)
    if (index + pasted.length > MAX_AGENT_IMAGES_PER_ROUND) {
      setErrors([`最多可填写 ${MAX_AGENT_IMAGES_PER_ROUND} 个 Key，请减少粘贴数量。`])
      return
    }
    if (!pasted.length) return
    invalidateModels()
    setKeys((current) => Array.from({ length: Math.max(current.length, index + pasted.length) }, (_, row) =>
      pasted[row - index] ?? current[row] ?? ''))
  }

  const readModels = async (): Promise<void> => {
    invalidateModels()
    let setup: ReturnType<typeof validateAgentImageQueueSetup>
    try {
      setup = validateAgentImageQueueSetup(address, keys)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : '请检查 API 地址和 Key。'])
      return
    }
    const controller = new AbortController()
    boundKeysRef.current = { address: address.trim(), keys: new Set(setup.entries.map((item) => item.key)) }
    controllerRef.current = controller
    setReading(true)
    const results = await settleWithConcurrency(setup.entries, MODEL_READ_CONCURRENCY, ({ key }) => {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason)
      return fetchAvailableModels({ baseUrl: setup.baseUrl, apiKey: key, apiProxy: false }, controller.signal)
    })
    if (controllerRef.current !== controller || controller.signal.aborted) return
    controllerRef.current = null
    setReading(false)

    const failures = results.flatMap((result, index) => {
      const keyNumber = setup.entries[index].index + 1
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : '读取失败，请重试。'
        return [`第 ${keyNumber} 个 Key：${message}`]
      }
      return result.value.length ? [] : [`第 ${keyNumber} 个 Key 没有返回可用模型。`]
    })
    if (failures.length) {
      setErrors(failures)
      return
    }

    const lists = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const modelSets = lists.slice(1).map((list) => new Set(list.map((item) => item.id)))
    const common = lists[0].filter((item) => modelSets.every((ids) => ids.has(item.id)))
    if (!common.length) {
      setErrors(['这些 Key 没有共同可用的模型，请检查它们的模型权限。'])
      return
    }
    setModels(common)
    if (common.length === 1) setModel(common[0].id)
    else if (common.some((item) => item.id === initial.model)) setModel(initial.model)
  }

  const save = async (): Promise<void> => {
    if (saving || !models.some((item) => item.id === model)) return
    setSaving(true)
    setErrors([])
    setNotice('')
    try {
      const setup = validateAgentImageQueueSetup(address, keys)
      await onSave(createAgentImageQueueSettings(draft, setup.baseUrl, setup.entries.map((item) => item.key), model))
      setNotice(`已保存 ${setup.entries.length} 个 Key 到多图队列。`)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : '保存失败，请重试。'])
    } finally {
      setSaving(false)
    }
  }

  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border border-black/10 p-4 dark:border-white/10" disabled={saving}>
      <legend className="px-1 text-sm font-medium text-gray-800 dark:text-gray-200">批量配置图像 API</legend>
      <p className="text-xs leading-5 text-gray-500">同一 API 地址可以填写多个 Key，也可以把每行一个的 Key 粘贴到第一个输入框。读取后选择所有 Key 共有的生图模型，再保存到多图队列。</p>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">共用 API 地址</span>
        <input type="url" value={address} autoComplete="off" placeholder="https://你的服务地址/v1" className={INPUT_CLASS} onChange={(event) => {
          const value = event.target.value
          invalidateModels()
          setAddress(value)
          const bound = boundKeysRef.current
          if (value.trim() !== bound.address) {
            setKeys((current) => current.map((key) => bound.keys.has(key.trim()) ? '' : key))
          }
        }} />
      </label>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        {keys.map((key, index) => (
          <label key={index} className="block min-w-0 space-y-1">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">API Key {index + 1}</span>
            <input type="password" value={key} autoComplete="off" spellCheck={false} className={INPUT_CLASS}
              placeholder={index === 0 ? '粘贴 Key，或粘贴每行一个的列表' : '可留空'}
              onPaste={(event) => pasteKeys(event, index)} onChange={(event) => {
                const value = event.target.value
                invalidateModels()
                setKeys((current) => current.map((old, row) => row === index ? value : old))
              }} />
          </label>
        ))}
      </div>
      {keys.length < MAX_AGENT_IMAGES_PER_ROUND && (
        <button type="button" className="text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => setKeys((current) => [...current, ''])}>添加一个 Key</button>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1 space-y-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">共同可用的生图模型</span>
          <Select ariaLabel="共同可用的生图模型" value={model} options={[{ value: '', label: '请选择读取到的模型' }, ...models.map((item) => ({ value: item.id, label: item.id }))]}
            onChange={(value) => { setModel(String(value)); setNotice('') }} disabled={!models.length || reading || saving} className={INPUT_CLASS} />
        </div>
        <button type="button" onClick={() => void readModels()} disabled={reading} className="rounded-xl bg-blue-500/10 px-4 py-2 text-sm text-blue-600 hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-400">
          {reading ? '正在读取…' : '读取模型'}
        </button>
        <button type="button" onClick={() => void save()} disabled={reading || !model} className="rounded-xl bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? '正在保存…' : '保存'}
        </button>
      </div>
      {errors.length > 0 && <ul role="alert" className="space-y-1 text-xs text-red-600 dark:text-red-400">{errors.map((message) => <li key={message}>{message}</li>)}</ul>}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>}
    </fieldset>
  )
}
