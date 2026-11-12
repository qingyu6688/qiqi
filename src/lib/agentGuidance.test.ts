import { describe, expect, it } from 'vitest'
import { getAgentGuidance, MAX_AGENT_INSTRUCTION_LENGTH, normalizeAgentInstructions } from './agentGuidance'
import { createDefaultOpenAIProfile, mergeImportedSettings, normalizeSettings } from './apiProfiles'
import { normalizeAgentConversations } from './agentConversationState'

describe('固定创作设定', () => {
  const existing = normalizeSettings({ profiles: [createDefaultOpenAIProfile({ id: 'own-api', apiKey: 'mock-key' })], activeProfileId: 'own-api', agentCustomInstructions: '本机偏好', galleryImageVariation: 'vary' })

  it('已有 API 配置时，完整备份仍能恢复全局指令和多图方案，保留现有 API', () => {
    const restored = mergeImportedSettings(existing, { profiles: [], agentCustomInstructions: '备份的水彩偏好', galleryImageVariation: 'preserve' }, { preserveInternalIds: true })
    expect(restored.agentCustomInstructions).toBe('备份的水彩偏好')
    expect(restored.galleryImageVariation).toBe('preserve')
    expect(restored.profiles.find((profile) => profile.id === 'own-api')?.apiKey).toBe('mock-key')
  })

  it('旧备份缺字段或字段损坏时保留本机偏好，明确备份的空指令可以清除', () => {
    for (const imported of [{ profiles: [] }, { profiles: [], agentCustomInstructions: 42, galleryImageVariation: '错误值' }]) {
      const restored = mergeImportedSettings(existing, imported, { preserveInternalIds: true })
      expect(restored.agentCustomInstructions).toBe('本机偏好')
      expect(restored.galleryImageVariation).toBe('vary')
    }
    expect(mergeImportedSettings(existing, { profiles: [], agentCustomInstructions: '' }, { preserveInternalIds: true }).agentCustomInstructions).toBe('')
  })

  it('普通 API 配置导入沿用本机创作偏好', () => {
    const merged = mergeImportedSettings(existing, { profiles: [], agentCustomInstructions: '导入偏好', galleryImageVariation: 'preserve' })
    expect(merged.agentCustomInstructions).toBe('本机偏好')
    expect(merged.galleryImageVariation).toBe('vary')
  })

  it('尚未配置 API 时，导入旧备份也不会清除已写好的创作偏好', () => {
    const fresh = normalizeSettings({ agentCustomInstructions: '先写好的角色', galleryImageVariation: 'vary' })
    for (const preserveInternalIds of [true, false]) {
      const restored = mergeImportedSettings(fresh, { profiles: [] }, { preserveInternalIds })
      expect(restored.agentCustomInstructions).toBe('先写好的角色')
      expect(restored.galleryImageVariation).toBe('vary')
    }
  })
  it('兼容旧数据，校验导入的类型和长度', () => {
    expect(normalizeAgentInstructions(null)).toBe('')
    expect(normalizeAgentInstructions({ text: '错误类型' })).toBe('')
    expect(normalizeAgentInstructions(`  ${'字'.repeat(9000)}  `)).toHaveLength(MAX_AGENT_INSTRUCTION_LENGTH)
    expect(normalizeSettings({}).agentCustomInstructions).toBe('')
    expect(normalizeSettings({ galleryImageVariation: '错误值' }).galleryImageVariation).toBe('preserve')
    expect(getAgentGuidance('', '')).toBe('')
  })

  it('设置和对话经过备份序列化、归一化后仍保留固定指令', () => {
    const settings = normalizeSettings(JSON.parse(JSON.stringify({ agentCustomInstructions: '  水彩画风  ', galleryImageVariation: 'vary' })))
    const conversations = normalizeAgentConversations(JSON.parse(JSON.stringify([{ id: 'a', title: '角色', instructions: '  戴蓝围巾的白猫  ', rounds: [], messages: [] }])))
    expect(settings.agentCustomInstructions).toBe('水彩画风')
    expect(settings.galleryImageVariation).toBe('vary')
    expect(conversations[0].instructions).toBe('戴蓝围巾的白猫')
    const guidance = getAgentGuidance(settings.agentCustomInstructions, conversations[0].instructions)
    expect(guidance).toContain('水彩画风')
    expect(guidance).toContain('戴蓝围巾的白猫')
    expect(guidance).toContain('当前用户明确提出的要求优先')
  })
})
