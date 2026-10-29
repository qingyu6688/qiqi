import { useState } from 'react'
import type { ApiProfile, AppSettings } from '../../types'
import { createDefaultOpenAIProfile, isAgentTextApiProfile, validateApiProfile } from '../../lib/apiProfiles'
import { isApiProxyAvailable, isApiProxyLocked, readClientDevProxyConfig } from '../../lib/devProxy'
import { getPresetProfileIds, isPresetAgentFieldLocked, isPresetConfigOnlyEnabled, isPresetProfileLocked } from '../../lib/presetConfig'
import { isTauri } from '../../lib/platform'
import ApiModelPicker from './ApiModelPicker'
import Select from '../Select'

interface TextApiSettingsTabProps {
  draft: AppSettings
  onDraftChange: (settings: AppSettings) => void
  commitSettings: (settings: AppSettings) => void
  onOpenConversationSettings: () => void
}

const INPUT_CLASS = 'w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none focus:border-blue-300 disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-200'

export default function TextApiSettingsTab({ draft, onDraftChange, commitSettings, onOpenConversationSettings }: TextApiSettingsTabProps) {
  const [profileId, setProfileId] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const availableProfiles = isPresetConfigOnlyEnabled() ? draft.profiles.filter((item) => getPresetProfileIds().has(item.id)) : draft.profiles
  const profiles = availableProfiles.filter(isAgentTextApiProfile)
  const profile = profiles.find((item) => item.id === profileId)
    ?? profiles.find((item) => item.id === draft.agentTextProfileId)
    ?? profiles[0]
  const locked = profile ? isPresetProfileLocked(profile.id) : false
  const proxyConfig = readClientDevProxyConfig()
  const imageProfile = availableProfiles.find((item) => item.id === draft.agentImageProfileId && !isAgentTextApiProfile(item))
    ?? availableProfiles.find((item) => item.id === draft.activeProfileId && !isAgentTextApiProfile(item))
    ?? availableProfiles.find((item) => !isAgentTextApiProfile(item))
  const bindingLocked = (['apiConfigMode', 'textProfileId', 'imageProfileId'] as const).some(isPresetAgentFieldLocked)
  const canConnect = profile && imageProfile && !validateApiProfile(profile) && !validateApiProfile(imageProfile) && !bindingLocked
  const connected = profile && draft.agentApiConfigMode === 'hybrid' && draft.agentTextProfileId === profile.id

  const updateProfile = (patch: Partial<ApiProfile>, commit = false): void => {
    if (!profile || (locked && (Object.keys(patch).length !== 1 || patch.apiKey === undefined))) return
    const next = { ...draft, profiles: draft.profiles.map((item) => item.id === profile.id ? { ...item, ...patch } : item) }
    if (commit) commitSettings(next)
    else onDraftChange(next)
  }

  const createProfile = (): void => {
    const nextProfile = createDefaultOpenAIProfile({
      id: `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: '文本 API',
      apiMode: 'responses',
      apiKey: '',
      streamImages: false,
      imageGenerationModel: '',
    })
    commitSettings({ ...draft, profiles: [...draft.profiles, nextProfile] })
    setProfileId(nextProfile.id)
    setShowKey(false)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-xs leading-5 text-gray-500 dark:text-gray-400">
        <h4 className="text-sm font-medium text-gray-800 dark:text-gray-100">文本 API</h4>
        <p>用于理解提示词、查看参考图和延续对话，再调用图像 API 生图。文本与图像可使用不同地址和 Key，各自读取模型。</p>
        <p>当前对话引擎使用 Responses API（/v1/responses），请选择支持看图和工具调用的文本模型。sub2api 使用 OpenAI 兼容地址。</p>
      </div>
      <div className="flex items-center gap-2">
        {profiles.length > 0 && <Select
          value={profile.id}
          options={profiles.map((item) => ({ label: item.name, value: item.id }))}
          onChange={(value) => { setProfileId(value); setShowKey(false) }}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />}
        {!isPresetConfigOnlyEnabled() && <button type="button" onClick={createProfile} className="shrink-0 rounded-xl bg-blue-500/10 px-3 py-2.5 text-sm text-blue-600 dark:text-blue-400">添加文本 API</button>}
      </div>
      {!profile ? <p className="rounded-xl bg-black/[0.04] p-3 text-xs leading-5 text-gray-500 dark:bg-white/[0.06]">尚未配置文本 API。点击“添加文本 API”，填写地址和 Key 后读取模型。</p> : <>
        <label className="block">
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">配置名称</span>
          <input aria-label="文本 API 配置名称" value={profile.name} disabled={locked} onChange={(event) => updateProfile({ name: event.target.value })} onBlur={() => commitSettings(draft)} className={INPUT_CLASS} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">API 地址</span>
          <input aria-label="文本 API 地址" value={profile.baseUrl} disabled={locked} onChange={(event) => updateProfile({ baseUrl: event.target.value })} onBlur={() => commitSettings(draft)} placeholder="https://你的服务地址/v1" type="url" className={INPUT_CLASS} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">API Key</span>
                {isTauri && <p className="mb-2 text-xs leading-5 text-gray-500">Windows 客户端使用当前账号加密保存密钥。换电脑请通过应用内导出、导入配置；导出文件含密钥，请妥善保管。</p>}
          <span className="flex items-center gap-2">
            <input aria-label="文本 API Key" value={profile.apiKey} onChange={(event) => updateProfile({ apiKey: event.target.value })} onBlur={() => commitSettings(draft)} type={showKey ? 'text' : 'password'} autoComplete="off" className={INPUT_CLASS} />
            <button type="button" aria-label={showKey ? '隐藏文本 API Key' : '显示文本 API Key'} onClick={() => setShowKey(!showKey)} className="shrink-0 px-1 text-xs text-gray-500">{showKey ? '隐藏' : '显示'}</button>
          </span>
        </label>
        {!isTauri && isApiProxyAvailable(proxyConfig) && <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={isApiProxyLocked(proxyConfig) || profile.apiProxy} disabled={locked || isApiProxyLocked(proxyConfig)} onChange={(event) => updateProfile({ apiProxy: event.target.checked }, true)} />
          使用同源 API 代理
        </label>}
        <ApiModelPicker key={profile.id} profile={profile} disabled={locked} showImageTool={false} onChange={(patch) => updateProfile(patch, true)} />
        <div className="space-y-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          <p className="text-xs leading-5 text-gray-500">配合图像 API：{imageProfile?.name ?? '请先在 API 配置中添加图像接口'}。关联后使用混合模式，画廊仍使用原来的 API。</p>
          <button type="button" disabled={!canConnect} onClick={() => {
            if (!canConnect) return
            commitSettings({ ...draft, agentApiConfigMode: 'hybrid', agentTextProfileId: profile.id, agentImageProfileId: imageProfile.id })
          }} className="rounded-xl bg-blue-500 px-4 py-2.5 text-sm text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40">{connected ? '已用于对话生图' : '用于对话生图'}</button>
          {!canConnect && <p className="text-xs leading-5 text-gray-500">{bindingLocked ? '对话 API 关联由部署配置锁定。' : '请先完成文本和图像 API 的地址、Key 与模型配置。'}</p>}
          <button type="button" onClick={onOpenConversationSettings} className="block text-xs text-blue-600 dark:text-blue-400">打开对话生图配置，调整模式与图像 API</button>
        </div>
      </>}
    </div>
  )
}
