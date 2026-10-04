const MAX_PREVIEW_CHARACTERS = 160

/** Shows a bounded prefix of the first meaningful line; the full content remains expandable. */
export function agentContentPreview(content: string) {
  const start = content.search(/\S/)
  if (start < 0) return ''
  const newline = content.indexOf('\n', start)
  const end = newline < 0 ? content.length : newline
  // Two UTF-16 units cover each Unicode code point without copying the full line.
  const sliceEnd = Math.min(end, start + 2 * (MAX_PREVIEW_CHARACTERS + 1))
  const characters = Array.from(content.slice(start, sliceEnd).trim().replace(/\s+/g, ' '))
  const truncated = sliceEnd < end || characters.length > MAX_PREVIEW_CHARACTERS
  return characters.slice(0, MAX_PREVIEW_CHARACTERS).join('') + (truncated ? '…' : '')
}
