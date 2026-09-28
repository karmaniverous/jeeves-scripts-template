/**
 * @module transcript-text
 *
 * Extracts text chunks from OpenClaw JSONL session transcript lines.
 */

/**
 * Extract text chunks from JSONL session lines. When `roleFilter` is set,
 * only messages with that role are included.
 */
function extractChunks(lines: string[], roleFilter?: string): string[] {
  const chunks: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Handle custom_message lines (e.g. openclaw.runtime-context)
      if (parsed.type === 'custom_message') {
        const content = parsed.content;
        if (typeof content === 'string' && content.trim()) {
          chunks.push(content);
        }
        continue;
      }

      if (parsed.type !== 'message') continue;

      const msg = parsed.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      if (roleFilter && msg.role !== roleFilter) continue;

      const content = msg.content;
      if (typeof content === 'string') {
        if (content.trim()) chunks.push(content);
      } else if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            const p = part as Record<string, unknown>;
            return typeof p.text === 'string' ? p.text : '';
          })
          .join('\n')
          .trim();
        if (text) chunks.push(text);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return chunks;
}

/** Extract user-only text chunks from session JSONL lines. */
export function extractUserTexts(lines: string[]): string[] {
  return extractChunks(lines, 'user');
}

/** Extract all text from session JSONL lines, joined into a single string. */
export function extractText(lines: string[]): string {
  return extractChunks(lines).join('\n');
}
