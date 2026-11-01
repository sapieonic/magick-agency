/**
 * `GET /client-config` — public, unauthenticated, rate-limited per IP like any other
 * unauthenticated request. What a client must know BEFORE it can sign in: today only the
 * mobile app's version gate.
 *
 * Read at app start and on resume. Served from server config (`MOBILE_*`, the platform
 * config block), so changing it is an env change and a restart, not a release.
 */
export interface ClientConfigResponse {
  mobile: MobileClientConfig;
}

export interface MobileClientConfig {
  /**
   * The oldest app version still allowed to run (`MOBILE_MIN_SUPPORTED_VERSION`). An app
   * older than this must block on an update screen. `MAJOR.MINOR.PATCH` only: a store
   * version has no prerelease or build part, so neither is accepted.
   */
  min_supported: string;
  /**
   * The newest released version (`MOBILE_LATEST_VERSION`), never older than
   * `min_supported`. An app between the two may suggest an update but must keep working.
   */
  latest: string;
  /**
   * Where the update screen sends the agent (`MOBILE_IOS_STORE_URL`,
   * `MOBILE_ANDROID_STORE_URL`, https only). Absent when neither is set, and each key absent
   * when its own variable is: the app then names the store instead of linking to it.
   */
  store_urls?: { ios?: string; android?: string };
}

/**
 * `POST /client-config/uplink-probe`: the mobile pre-flight's upload-speed check before
 * "Go on duty" (the app blocks below 64 kbps). The app uploads 32 KB of
 * `application/octet-stream` and times the round trip; the server only counts the bytes.
 *
 * Authenticated (a Firebase bearer; no tenant headers needed), because a public endpoint
 * that reads bodies would be a free upload sink. Body at most 65536 bytes (413 above), any
 * other content type 415, and at most 6 probes per user per rate-limit window (429), on top
 * of the per-user bucket every authenticated request is charged to.
 */
export interface UplinkProbeResponse {
  /** Bytes of the request body the server read. */
  received_bytes: number;
}
