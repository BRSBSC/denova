import { describe, expect, it } from 'vitest'
import { agentContentPreview } from './agent-content-preview'

describe('thinking content preview', () => {
  it('preserves the first meaningful line for ordinary content', () => {
    expect(agentContentPreview(' \r\n \n First   observation \r\nNext observation')).toBe('First observation')
    expect(agentContentPreview(' \r\n \t')).toBe('')
  })
  it('bounds long collapsed previews without changing the source content', () => {
    const content = 'Review the chapter. '.repeat(10_000)
    const preview = agentContentPreview(content)
    expect([...preview].length).toBeLessThanOrEqual(161)
    expect(preview.endsWith('…')).toBe(true)
    expect(content.startsWith(preview.slice(0, -1))).toBe(true)
    expect(content.length).toBe(200_000)
    expect(agentContentPreview('\n' + '😀'.repeat(500))).toBe('😀'.repeat(160) + '…')
  })
})
