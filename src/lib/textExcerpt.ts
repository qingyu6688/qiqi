/** 在字符预算内同时保留首尾，摘录标记也计入长度。 */
export function excerptText(text: string, limit: number, marker = '\n……（中间内容已摘录）……\n'): string {
  const length = Math.max(0, Math.trunc(limit))
  if (text.length <= length) return text
  if (length <= marker.length) return marker.slice(0, length)
  const head = Math.ceil((length - marker.length) / 2)
  const tail = length - marker.length - head
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '')
}
