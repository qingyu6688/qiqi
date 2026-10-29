import { describe, expect, it } from 'vitest'
import { createIndependentImagePrompt } from './independentImages'

describe('多图独立提示词', () => {
  it('五个序号分别只要求一张作品，并保留完整的主题与风格', () => {
    const prompt = '五张圣诞纹样：圣诞树和雪人、姜饼人、绿色挂饰、驯鹿、红底雪花，统一手绘风格'
    const prompts = Array.from({ length: 5 }, (_, index) => createIndependentImagePrompt(prompt, index, 5))
    expect(new Set(prompts).size).toBe(5)
    for (const [index, value] of prompts.entries()) {
      expect(value).toContain(`第 ${index + 1} 张，共 5 张`)
      expect(value).toContain('只生成一张独立、完整')
      expect(value).toContain('只画与本张序号对应的那一项')
      expect(value).toContain('不得因原文要求多张或多款而制作拼贴')
      expect(value.endsWith(prompt)).toBe(true)
    }
  })

  it('以数量控件为准，不因提示词写了五张而增加请求数量', () => {
    expect(createIndependentImagePrompt('生成五张不同的纹样', 3, 4)).toContain('第 4 张，共 4 张')
  })

  it.each([[0, 1], [-1, 5], [5, 5], [0, Number.NaN], [0.5, 5]])('单图或无效序号不改写提示词（%s/%s）', (index, count) => {
    expect(createIndependentImagePrompt('画一张五宫格海报', index, count)).toBe('画一张五宫格海报')
  })
})
