export const MAX_AGENT_INSTRUCTION_LENGTH = 8000

export function normalizeAgentInstructions(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_AGENT_INSTRUCTION_LENGTH) : ''
}

export function getAgentGuidance(globalInstructions: unknown, conversationInstructions: unknown): string {
  const global = normalizeAgentInstructions(globalInstructions)
  const conversation = normalizeAgentInstructions(conversationInstructions)
  if (!global && !conversation) return ''
  return [
    '固定创作设定：写每张图片的提示词时保留适用的设定。当前用户明确提出的要求优先，其次是本对话设定，最后是全局偏好。',
    ...(global ? [`全局偏好：\n${global}`] : []),
    ...(conversation ? [`本对话设定：\n${conversation}`] : []),
  ].join('\n\n')
}
