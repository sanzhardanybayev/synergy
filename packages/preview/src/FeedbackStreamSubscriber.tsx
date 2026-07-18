/**
 * FeedbackStreamSubscriber — invisible; subscribes to the feedback SSE stream
 * for the current session and bumps the shared comment refresh key on every
 * `feedback-changed` frame, so the comments panel, highlights, and toolbar
 * badge refetch live (new comments from another tab, agent resolutions).
 *
 * No poll fallback: comments still refresh on user actions via the same key,
 * so a failed stream degrades to the pre-stream manual behavior.
 */

import { useEffect } from 'react';
import { useEditBuffer } from './EditBuffer.js';

export function FeedbackStreamSubscriber({ session }: { session: string }) {
  const { bumpCommentRefresh, setAgentListening } = useEditBuffer();

  useEffect(() => {
    const source = new EventSource(`/api/feedback/stream?session=${encodeURIComponent(session)}`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; listening?: boolean };
        if (payload.type === 'feedback-changed') bumpCommentRefresh();
        if (payload.type === 'presence') setAgentListening(payload.listening === true);
      } catch {
        /* malformed frame — skip */
      }
    };
    // A dropped stream must not freeze a green dot on screen.
    source.onerror = () => setAgentListening(false);
    return () => {
      source.close();
      setAgentListening(false);
    };
  }, [session, bumpCommentRefresh, setAgentListening]);

  return null;
}
