import { auth, apiUrl } from './auth'

export interface CreativeCommandProposal {
  kind: string
  assistant_message: string
  requires_confirmation: boolean
  scope: Record<string, unknown>
  questions: string[]
}

export async function proposeCreativeCommand(
  runId: string | undefined | null,
  content: string,
  scope: Record<string, unknown> = {},
): Promise<CreativeCommandProposal | null> {
  const normalizedRunId = String(runId || '').trim()
  const normalizedContent = content.trim()
  if (!normalizedRunId || !normalizedContent) return null
  try {
    const response = await auth.fetchWithAuth(apiUrl(`/api/agent/runs/${normalizedRunId}/commands`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: normalizedContent,
        scope,
        // The specialist endpoint already persists the actual user action.
        // Avoid duplicating it in the module conversation.
        persist_to_conversation: false,
      }),
    })
    if (!response.ok) return null
    const payload = await response.json()
    return payload?.proposal || null
  } catch {
    // Command telemetry must not block a user's already-supported edit action.
    return null
  }
}
