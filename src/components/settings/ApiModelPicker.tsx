import { useEffect, useRef, useState } from 'react'
import type { ApiProfile } from '../../types'
import type { AvailableModel } from '../../types/models'
import { fetchAvailableModels } from '../../api/models'
import Select from '../Select'
import { PawIcon } from '../CatDecorations'

interface ApiModelPickerProps {
  profile: ApiProfile
  disabled: boolean
  onChange: (patch: Partial<ApiProfile>) => void
  showImageTool?: boolean
}

export default function ApiModelPicker({ profile, disabled, onChange, showImageTool = true }: ApiModelPickerProps) {
  const connection = JSON.stringify([profile.id, profile.provider, profile.baseUrl, profile.apiKey, profile.apiProxy])
  const [result, setResult] = useState<{ connection: string; models: AvailableModel[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const models = result?.connection === connection ? result.models : []
  const hasResult = result?.connection === connection
  const selected = profile.model.split(/[,，\n]/).map((id) => id.trim()).filter(Boolean)
  const query = search.trim().toLowerCase()
  const visibleModels = models.filter((model) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(query))

  useEffect(() => {
    setResult(null)
    setError('')
    setSearch('')
    setLoading(false)
    return () => controllerRef.current?.abort()
  }, [connection])

  const readModels = async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const available = await fetchAvailableModels(profile, controller.signal)
      if (!controller.signal.aborted) setResult({ connection, models: available })
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取模型失败，请重试')
    } finally {
      if (controllerRef.current === controller && !controller.signal.aborted) setLoading(false)
    }
  }

  const toggleModel = (id: string) => {
    const current = selected.filter((value) => models.some((model) => model.id === value))
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    if (!next.length) return
    onChange({ model: next.join(', '), selectedModel: next.includes(profile.selectedModel ?? '') ? profile.selectedModel : next[0] })
  }

  return (
    <section className="space-y-2" aria-label="可用模型">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-600 dark:text-gray-300">{profile.apiMode === 'responses' ? '对话模型' : '生图模型'}</span>
        <button
          type="button"
          onClick={() => void readModels()}
          disabled={loading || !profile.apiKey.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400"
        >
          <PawIcon className="h-3.5 w-3.5 opacity-70" />
          {loading ? '正在读取…' : hasResult ? '刷新模型' : '读取模型'}
        </button>
      </div>
      <p className="text-xs leading-5 text-gray-500">填写地址和 Key 后读取，仅展示当前 Key 返回的可用模型。可勾选多个，在首页切换。</p>
      {selected.length > 0 && <p className="break-words text-xs leading-5 text-gray-500">当前已选：{selected.join('、')}</p>}
      {hasResult && models.length > 0 && selected.some((id) => !models.some((model) => model.id === id)) && (
        <p role="status" className="text-xs leading-5 text-amber-600 dark:text-amber-400">已保存的部分模型不在当前 Key 的列表中，请从下方重新选择。</p>
      )}
      {error && <p role="alert" className="text-xs leading-5 text-red-500">{error}</p>}
      {loading && <p role="status" className="text-xs text-gray-500">正在获取当前 Key 的模型权限…</p>}
      {hasResult && models.length === 0 && <p role="status" className="rounded-xl bg-black/[0.04] p-3 text-xs text-gray-500 dark:bg-white/[0.06]">当前 Key 未返回可用模型，请检查 sub2api 的密钥分组和模型权限。</p>}
      {models.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
          <input aria-label="搜索可用模型" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型名称" className="w-full border-b border-gray-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:text-gray-200" />
          <div className="max-h-52 overflow-y-auto p-1">
            {visibleModels.length === 0 && <p className="px-2 py-3 text-xs text-gray-500">没有匹配的模型</p>}
            {visibleModels.map((model) => (
              <label key={model.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                <input type="checkbox" aria-label={model.id} checked={selected.includes(model.id)} onChange={() => toggleModel(model.id)} disabled={disabled || (selected.length === 1 && selected[0] === model.id)} className="mt-0.5 accent-blue-600" />
                <span className="min-w-0 break-all text-xs text-gray-700 dark:text-gray-200">{model.id}{model.name && <span className="mt-1 block text-gray-500">{model.name}</span>}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {showImageTool && profile.provider === 'openai' && profile.apiMode === 'responses' && (
        <div className="space-y-1 pt-2">
          <span className="text-sm text-gray-600 dark:text-gray-300">原生工具的图像模型</span>
          <Select
            value={profile.imageGenerationModel ?? ''}
            options={[{ label: '使用服务商默认图像模型', value: '' }, ...models.map((model) => ({ label: model.id, value: model.id }))]}
            onChange={(value) => onChange({ imageGenerationModel: value })}
            disabled={disabled || !hasResult || models.length === 0}
            className="w-full rounded-xl bg-black/[0.04] px-3 py-2.5 text-sm dark:bg-white/[0.06] dark:text-gray-200"
          />
          <p className="text-xs leading-5 text-gray-500">仅原生图像工具使用此项；混合模式使用单独的生图配置。模型列表不代表每个模型都支持图像工具。</p>
        </div>
      )}
    </section>
  )
}
