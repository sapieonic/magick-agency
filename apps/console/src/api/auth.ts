import { ENDPOINTS } from '../config';
import type { MeResponse, SessionResponse } from '../types/auth';
import { apiFetch } from './client';

export function createSession(idToken: string, phoneNumber?: string): Promise<SessionResponse> {
  return apiFetch(ENDPOINTS.auth.session, {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken, phone_number: phoneNumber }),
  });
}

export function getMe(): Promise<MeResponse> {
  return apiFetch(ENDPOINTS.auth.me);
}
