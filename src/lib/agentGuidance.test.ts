import { describe, expect, it } from 'vitest'
import { getAgentGuidance, MAX_AGENT_INSTRUCTION_LENGTH, normalizeAgentInstructions } from './agentGuidance'
import { normalizeSettings } from './apiProfiles'
import { normalizeAgentConversations } from './agentConversationState'

describe('固定创作设定', () => {
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
