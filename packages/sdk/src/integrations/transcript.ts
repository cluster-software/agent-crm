// Canonical transcript-payload shape that `importTranscript()` consumes.
// Provider adapters (Granola, manual file, future Otter/Fireflies/etc.) all
// emit this shape; the operation never sees provider-specific bytes.

export type ParticipantInput = {
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
};

export type TranscriptPayload = {
  source: string;
  source_id: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number;
  summary?: string;
  content?: string;
  participants: ParticipantInput[];
};
