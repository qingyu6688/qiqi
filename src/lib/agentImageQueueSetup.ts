import { MAX_AGENT_IMAGES_PER_ROUND, type ApiProfile, type AppSettings } from '../types'
import { createDefaultOpenAIProfile, getAgentImageQueueProfiles, resolveApiProfileModel } from './apiProfiles'
import { buildApiUrl, normalizeBaseUrl } from './devProxy'

export const INITIAL_QUEUE_KEY_COUNT = 5

function usesImageEndpoint(profile: ApiProfile, baseUrl: string): boolean {
  return profile.provider === 'openai' && profile.apiMode === 'images' && !profile.apiProxy && !!profile.baseUrl
    && buildApiUrl(profile.baseUrl, 'models') === buildApiUrl(baseUrl, 'models')
}

export function getAgentImageQueueSetup(settings: AppSettings, primary: ApiProfile | null): { baseUrl: string; keys: string[]; model: string } {
  const profile = primary?.provider === 'openai' && primary.apiMode === 'images' && !primary.apiProxy ? resolveApiProfileModel(primary) : null
  const baseUrl = profile?.baseUrl ?? ''
  const saved = profile ? getAgentImageQueueProfiles(settings, profile).filter((item) => usesImageEndpoint(item, baseUrl)) : []
  const keys = Array.from({ length: Math.max(INITIAL_QUEUE_KEY_COUNT, Math.min(saved.length, MAX_AGENT_IMAGES_PER_ROUND)) }, (_, index) => saved[index]?.apiKey ?? '')
  return { baseUrl, keys, model: profile?.model ?? '' }
}

export function validateAgentImageQueueSetup(address: string, keys: string[]): { baseUrl: string; entries: Array<{ index: number; key: string }> } {
  const raw = address.trim()
  if (!raw) throw new Error('请填写 API 地址。')
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('地址格式不支持')
  } catch {
    throw new Error('请输入完整的 HTTP 或 HTTPS API 地址，地址中不要包含账号、密码或查询参数。')
  }
  const entries = keys.map((key, index) => ({ index, key: key.trim() })).filter((item) => item.key)
  if (!entries.length) throw new Error('请至少填写一个 API Key。')
  const seen = new Set<string>()
  for (const { index, key } of entries) {
    if (/[^\x21-\x7e]/.test(key)) throw new Error(`第 ${index + 1} 个 Key 含有空格或无效字符。`)
    if (seen.has(key)) throw new Error(`第 ${index + 1} 个 Key 重复，请使用不同的 Key。`)
    seen.add(key)
  }
  return { baseUrl: normalizeBaseUrl(raw), entries }
}

export function createAgentImageQueueSettings(settings: AppSettings, baseUrl: string, keys: string[], model: string): AppSettings {
  const profiles = [...settings.profiles]
  const usedNames = new Set(profiles.map((profile) => profile.name))
  let nextNameIndex = 1
  const [primary, ...extra] = keys.map((apiKey) => {
    const existing = profiles.find((profile) => usesImageEndpoint(profile, baseUrl)
      && profile.apiKey.trim() === apiKey && resolveApiProfileModel(profile).model === model)
    if (existing) return existing

    while (usedNames.has(`图像队列 ${nextNameIndex}`)) nextNameIndex += 1
    const name = `图像队列 ${nextNameIndex++}`
    const profile = createDefaultOpenAIProfile({
      id: `image-queue-${crypto.randomUUID()}`, name, baseUrl, apiKey, apiMode: 'images', model,
      selectedModel: model, apiProxy: false, codexCli: false, streamImages: false,
    })
    profiles.push(profile)
    usedNames.add(name)
    return profile
  })
  return {
    ...settings,
    profiles,
    agentApiConfigMode: 'hybrid',
    agentImageProfileId: primary.id,
    agentImageQueueProfileIds: extra.map((profile) => profile.id),
  }
}
