// Exercise the real configuration Agent, Lore discovery and image tool commit path.
export function loreCompletion(body) {
  const messages = body.messages ?? []
  const userIndex = messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('E2E_LORE_BATCH'))
  if (userIndex < 0) return null
  const instruction = typeof messages[userIndex].content === 'string'
    ? messages[userIndex].content
    : JSON.stringify(messages[userIndex].content).replaceAll('\\n', '\n').replaceAll('\\"', '"')
  const ids = JSON.parse(instruction.match(/Exact lore item IDs: (\[[^\n]+\])/)[1])
  const missingOnly = instruction.includes('Only fill missing covers.')
  const history = messages.slice(userIndex + 1)
  const calls = history.flatMap(message => message.tool_calls ?? [])
  const call = (tool, args, id) => ({ tool, arguments: JSON.stringify(args), id })
  if (!calls.some(entry => entry.function.name === 'read_lore_items')) {
    return call('read_lore_items', { ids }, `read-${userIndex}`)
  }
  for (const id of ids) {
    const listID = `list-${userIndex}-${id}`
    if (!calls.some(entry => entry.id === listID)) return call('list_lore_materials', { item_id: id }, listID)
    const metadata = history.find(message => message.role === 'tool' && message.tool_call_id === listID)
    const text = typeof metadata?.content === 'string' ? metadata.content : JSON.stringify(metadata?.content)
    if (missingOnly && /"cover_asset_id"\s*:\s*"[^"]+"/.test(text)) continue
    const imageID = `image-${userIndex}-${id}`
    if (!calls.some(entry => entry.id === imageID)) {
      return call('generate_image', {
        purpose: 'lore_item', lore_item_id: id, prompt: `A watercolor portrait for ${id}, soft daylight, no text.`,
        ...(missingOnly ? { lore_cover: 'if_missing' } : {}),
      }, imageID)
    }
  }
  return { content: 'E2E Lore batch completed.' }
}
