// PORT NOTE (magick-agency): ported from magic-voice-core/src/db/models/announcement.model.ts@4850d1d9.
// Changed (baseline decision 4, uploaded clip only — see packages/db/BASELINE.md
// `announcements`): removed `tts_text`, `tts_voice`, `tts_language` from the record
// and both input types (the columns are dropped), and narrowed `type` from
// `'tts' | 'audio'` to `'audio'` (the CHECK is `type IN ('audio')`).
export interface AnnouncementRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  type: 'audio';
  audio_file_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAnnouncementInput {
  tenant_id: string;
  account_id: string;
  name: string;
  type: 'audio';
  audio_file_id?: string;
}

export interface UpdateAnnouncementInput {
  name?: string;
  type?: 'audio';
  audio_file_id?: string;
}
