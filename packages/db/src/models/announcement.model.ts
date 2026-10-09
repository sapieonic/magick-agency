// Uploaded clip only (see packages/db/BASELINE.md
// `announcements`): the record and both input types carry no `tts_text`,
// `tts_voice` or `tts_language` (the columns do not exist), and `type` is
// `'audio'` only (the CHECK is `type IN ('audio')`).
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
