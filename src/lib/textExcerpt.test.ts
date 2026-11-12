import { expect, it } from 'vitest'
import { excerptText } from './textExcerpt'

it('完整文本不改写，摘录同时保留首尾并计入标记长度', () => {
  expect(excerptText('完整文字', 10)).toBe('完整文字')
  const original = `开头禁止红色${'过程'.repeat(2000)}结尾必须蓝色`
  const excerpt = excerptText(original, 200)
  expect(excerpt.length).toBeLessThanOrEqual(200)
  expect(excerpt.startsWith('开头禁止红色')).toBe(true)
  expect(excerpt.endsWith('结尾必须蓝色')).toBe(true)
  expect(excerpt).toContain('中间内容已摘录')
})

it.each([0, 1, 10, 20, 100, 2000])('极小预算也不会超出 %s 字符', (limit) => {
  expect(excerptText('资料'.repeat(5000), limit).length).toBeLessThanOrEqual(limit)
})
