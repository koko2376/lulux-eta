export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Reads a fetch body and yields every `data:` payload of an SSE stream.
 * The provider-specific adapter only has to interpret the JSON payloads.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLines = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())

        if (dataLines.length > 0) {
          yield dataLines.join('\n')
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function readErrorMessage(
  response: Response,
): Promise<string> {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return `HTTP ${response.status}`
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed
}
