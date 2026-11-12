/** 多图请求按序号选择主题，单张请求保留用户原来的画面布局。 */
export function createIndependentImagePrompt(prompt: string, index: number, total: number, variation: 'preserve' | 'vary' = 'preserve'): string {
  if (!Number.isInteger(total) || total <= 1 || !Number.isInteger(index) || index < 0 || index >= total) return prompt
  return [
    `【独立出图：第 ${index + 1} 张，共 ${total} 张】`,
    '本次请求只生成一张独立、完整、可单独使用的图片，其他图片由其他请求生成。',
    '如果原始要求列出了多个主题、款式或编号，只画与本张序号对应的那一项，不要把全部主题放进同一张画布。',
    variation === 'vary'
      ? '没有逐项列出时，围绕原主题设计本张独立方案，在用户允许的范围内变化构图或细节。'
      : '没有逐项列出时，保持同一方案及构图，保留全部指定的文字、元素、位置与细节，供用户从同一方案的多张结果中挑选。',
    '保持用户要求的风格、角色、配色和尺寸；满版纹样可以重复本张主题的元素。不得因原文要求多张或多款而制作拼贴、宫格、分屏、合集预览、接触表，也不要添加序号或其他图片的缩略图。只有用户明确要求单张作品本身使用拼贴或分格布局时才保留该布局。',
    '【原始创作要求】',
    prompt,
  ].join('\n')
}
