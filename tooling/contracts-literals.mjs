#!/usr/bin/env node
/**
 * Extracts the closed string vocabularies the agent app switches on from the TypeScript
 * sources of `packages/contracts` into `packages/contracts/fixtures/agent/literals.json`.
 *
 * The mobile app is Dart and cannot import the contract, so its wire package
 * (`apps/mobile/packages/agency_wire`) has a test asserting every literal in that JSON is
 * a value its enums know. A literal added on the TypeScript side therefore fails the Dart
 * suite instead of decoding as `unknown` in the field. For the vocabularies whose Dart enum
 * mirrors it one to one, and for every value the app sends (`client=mobile`,
 * `media=alaw8`, a DNC `scope`, a stats `bucket`, an `outcome` filter, `device_away`), the
 * suite also checks the other way, so a value renamed or removed here fails it too.
 *
 *   node tooling/contracts-literals.mjs           write the JSON
 *   node tooling/contracts-literals.mjs --check   exit 1 when the committed JSON is stale
 *
 * The contracts package's Vitest suite runs the same comparison (`agent-fixtures.test.ts`),
 * so `pnpm test` fails on a stale file too.
 *
 * ── How it reads TypeScript without a TypeScript toolchain ──────────────────
 * No dependencies, deliberately: it reads the source text, strips comments with a small
 * string-aware scanner, then matches four declaration shapes, each strictly:
 *
 *   - `export type X = | 'a' | 'b';`            a literal union (the body must be ONLY
 *                                               literals and `|`, or extraction fails);
 *   - `export const X = ['a', 'b'] as const`    a const list (same rule);
 *   - `export const X = { A: 4401, … } as const` a const object of numbers;
 *   - one field of an interface whose type is an inline literal union.
 *
 * Anything else (a union that starts referencing another type, a list built by spread)
 * throws with the declaration's name rather than producing a partial list. When that
 * happens, change the vocabulary's entry below, not the regexes.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages/contracts/src');
export const LITERALS_PATH = join(ROOT, 'packages/contracts/fixtures/agent/literals.json');

/** Removes `//` and `/* *\/` comments, leaving string and template literals intact. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i++;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const sources = new Map();
function source(file) {
  if (!sources.has(file)) sources.set(file, stripComments(readFileSync(join(SRC, file), 'utf8')));
  return sources.get(file);
}

const LITERAL_LIST = /^\s*\|?\s*'[^']*'(\s*[|,]\s*'[^']*')*\s*,?\s*$/;

function literalsIn(body, what) {
  if (!LITERAL_LIST.test(body)) {
    throw new Error(`${what} is not a plain literal list; update tooling/contracts-literals.mjs`);
  }
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** `export type Name = 'a' | 'b';` */
function typeUnion(file, name) {
  const m = new RegExp(`export type ${name}\\s*=([^;]*);`).exec(source(file));
  if (!m) throw new Error(`type ${name} not found in ${file}`);
  return literalsIn(m[1], `type ${name}`);
}

/** `export const NAME = ['a', 'b'] as const` */
function constList(file, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const`).exec(source(file));
  if (!m) throw new Error(`const ${name} not found in ${file}`);
  return literalsIn(m[1], `const ${name}`);
}

/** `export const NAME = { A: 1, B: 2 } as const` → `{ A: 1, B: 2 }` */
function constNumberObject(file, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([^}]*)\\}\\s*as const`).exec(source(file));
  if (!m) throw new Error(`const ${name} not found in ${file}`);
  const entries = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (const entry of entries) {
    const kv = /^([A-Z_][A-Z0-9_]*)\s*:\s*(\d+)$/.exec(entry);
    if (!kv) throw new Error(`const ${name}: cannot read entry "${entry}"`);
    out[kv[1]] = Number(kv[2]);
  }
  return out;
}

/** The body of `export interface Name … { … }`, brace-matched. */
function interfaceBody(file, name) {
  const text = source(file);
  const m = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (depth > 0 && i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return text.slice(start, i - 1);
}

/**
 * An interface field typed as an inline literal union: `status: | 'a' | 'b';`, or an
 * optional one (`status?: 'a' | 'b';`, the list query's filter).
 */
function fieldUnion(file, iface, field) {
  const body = interfaceBody(file, iface);
  if (body === null) throw new Error(`interface ${iface} not found in ${file}`);
  const m = new RegExp(`\\b${field}\\??\\s*:([^;]*);`).exec(body);
  if (!m) throw new Error(`${iface}.${field} not found`);
  return literalsIn(m[1], `${iface}.${field}`);
}

/**
 * The break codes the server reserves (entered only through their own routes, never offered
 * in a campaign's `break_reasons`): the contract's `RESERVED_BREAK_REASONS` list
 * (`agency/breaks.ts`), whose members are constants (`SOFTPHONE_BREAK_REASON`, …), each
 * resolved to its `'<code>'` wherever in `agency/` it is declared. Reading the list, not a
 * naming convention, means a new reserved code is picked up the moment it is listed.
 */
function reservedBreakCodes() {
  const list = /export const RESERVED_BREAK_REASONS\s*=\s*\[([^\]]*)\]\s*as const/.exec(source('agency/breaks.ts'));
  if (!list) throw new Error('const RESERVED_BREAK_REASONS not found in agency/breaks.ts');
  const names = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const files = readdirSync(join(SRC, 'agency')).filter((f) => f.endsWith('.ts')).map((f) => `agency/${f}`);
  const out = names.map((name) => {
    for (const file of files) {
      const m = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`).exec(source(file));
      if (m) return m[1];
    }
    throw new Error(`RESERVED_BREAK_REASONS names ${name}, which no agency/*.ts declares as a string`);
  });
  if (out.length === 0) throw new Error('RESERVED_BREAK_REASONS is empty');
  return out.sort();
}

/** The `event` of every member of a frame union, resolved through the member interfaces. */
function frameEvents(unionFile, unionName, memberFiles) {
  const m = new RegExp(`export type ${unionName}\\s*=([^;]*);`).exec(source(unionFile));
  if (!m) throw new Error(`type ${unionName} not found in ${unionFile}`);
  const members = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  return members.map((member) => {
    for (const file of memberFiles) {
      const body = interfaceBody(file, member);
      if (body === null) continue;
      const ev = /\bevent\s*:\s*'([^']+)'\s*;/.exec(body);
      if (!ev) throw new Error(`${member} has no literal \`event\``);
      return ev[1];
    }
    throw new Error(`${unionName} member ${member} not found in ${memberFiles.join(', ')}`);
  });
}

/** Each vocabulary: where it is declared, and how to read it. */
const VOCABULARIES = {
  agent_states: ['agency/enums.ts#AgencyAgentState', () => typeUnion('agency/enums.ts', 'AgencyAgentState')],
  attempt_states: ['agency/enums.ts#AgencyAttemptState', () => typeUnion('agency/enums.ts', 'AgencyAttemptState')],
  attempt_outcomes: ['agency/enums.ts#AgencyAttemptOutcome', () => typeUnion('agency/enums.ts', 'AgencyAttemptOutcome')],
  contact_states: ['agency/enums.ts#AgencyContactState', () => typeUnion('agency/enums.ts', 'AgencyContactState')],
  campaign_statuses: ['agency/enums.ts#AgencyCampaignStatus', () => typeUnion('agency/enums.ts', 'AgencyCampaignStatus')],
  release_reasons: ['agency/station.ts#AgencyReleaseReason', () => typeUnion('agency/station.ts', 'AgencyReleaseReason')],
  campaign_change_reasons: [
    'agency/station.ts#AgencyCampaignChangeReason',
    () => typeUnion('agency/station.ts', 'AgencyCampaignChangeReason'),
  ],
  station_error_codes: ['agency/station.ts#AgencyStationErrorCode', () => typeUnion('agency/station.ts', 'AgencyStationErrorCode')],
  bridge_statuses: [
    'agency/station.ts#AgencyStationBridgeStatusFrame.status',
    () => fieldUnion('agency/station.ts', 'AgencyStationBridgeStatusFrame', 'status'),
  ],
  station_close_codes: ['agency/station.ts#AGENCY_STATION_CLOSE', () => constNumberObject('agency/station.ts', 'AGENCY_STATION_CLOSE')],
  station_server_events: [
    'agency/station.ts#AgencyStationServerFrame',
    () => frameEvents('agency/station.ts', 'AgencyStationServerFrame', ['agency/station.ts', 'agency/actions.ts', 'agency/softphone.ts']),
  ],
  wrapup_hold_reasons: ['agency/actions.ts#AgencyWrapupHoldReason', () => typeUnion('agency/actions.ts', 'AgencyWrapupHoldReason')],
  dnc_scopes: ['agency/actions.ts#AgencyDncScope', () => typeUnion('agency/actions.ts', 'AgencyDncScope')],
  session_kinds: ['agency/softphone.ts#AGENCY_SESSION_KINDS', () => constList('agency/softphone.ts', 'AGENCY_SESSION_KINDS')],
  reserved_break_codes: ['agency/breaks.ts#RESERVED_BREAK_REASONS', reservedBreakCodes],
  action_error_codes: ['errors.ts#AGENCY_ACTION_ERROR_CODES', () => constList('errors.ts', 'AGENCY_ACTION_ERROR_CODES')],
  roles: ['rbac.ts#ROLES', () => constList('rbac.ts', 'ROLES')],
  invite_unavailable_statuses: [
    'api/platform/invite.ts#InviteUnavailableStatus',
    () => typeUnion('api/platform/invite.ts', 'InviteUnavailableStatus'),
  ],
  invite_claim_refusal_statuses: [
    'api/platform/invite.ts#InviteClaimRefusalStatus',
    () => typeUnion('api/platform/invite.ts', 'InviteClaimRefusalStatus'),
  ],
  // Values the app SENDS as well as reads: the Dart suite checks these both ways, so a
  // rename on this side fails it rather than a phone's upgrade (1008) or request (400).
  client_kinds: ['agency/station.ts#AGENCY_CLIENT_KINDS', () => constList('agency/station.ts', 'AGENCY_CLIENT_KINDS')],
  station_media_formats: [
    'agency/station.ts#AGENCY_STATION_MEDIA_FORMATS',
    () => constList('agency/station.ts', 'AGENCY_STATION_MEDIA_FORMATS'),
  ],
  stats_bucket_units: ['primitives.ts#STATS_BUCKET_UNITS', () => constList('primitives.ts', 'STATS_BUCKET_UNITS')],
  // The soft phone's refusals: the Dart `SoftphoneErrorCode` mirrors them one to one.
  softphone_error_codes: [
    'errors.ts#AGENCY_SOFTPHONE_ERROR_CODES',
    () => constList('errors.ts', 'AGENCY_SOFTPHONE_ERROR_CODES'),
  ],
  // The soft phone's call row, settings and refusals (`agency/softphone.ts`). The manual
  // call's state and outcome are aliases of the attempt unions, so they are read from their
  // own runtime lists: the Dart suite checks them one to one against the attempt enums.
  manual_call_states: [
    'agency/softphone.ts#AGENCY_MANUAL_CALL_STATES',
    () => constList('agency/softphone.ts', 'AGENCY_MANUAL_CALL_STATES'),
  ],
  manual_call_outcomes: [
    'agency/softphone.ts#AGENCY_MANUAL_CALL_OUTCOMES',
    () => constList('agency/softphone.ts', 'AGENCY_MANUAL_CALL_OUTCOMES'),
  ],
  manual_call_end_reasons: [
    'agency/softphone.ts#AGENCY_MANUAL_CALL_END_REASONS',
    () => constList('agency/softphone.ts', 'AGENCY_MANUAL_CALL_END_REASONS'),
  ],
  manual_call_disposition_sources: [
    'agency/softphone.ts#AGENCY_MANUAL_CALL_DISPOSITION_SOURCES',
    () => constList('agency/softphone.ts', 'AGENCY_MANUAL_CALL_DISPOSITION_SOURCES'),
  ],
  call_field_types: ['agency/softphone.ts#AGENCY_CALL_FIELD_TYPES', () => constList('agency/softphone.ts', 'AGENCY_CALL_FIELD_TYPES')],
  dnc_entry_scopes: ['agency/softphone.ts#AgencyDncEntryScope', () => typeUnion('agency/softphone.ts', 'AgencyDncEntryScope')],
  // The app SENDS these as the list's `status=` filter.
  manual_call_list_statuses: [
    'agency/softphone.ts#AgencyManualCallListQuery.status',
    () => fieldUnion('agency/softphone.ts', 'AgencyManualCallListQuery', 'status'),
  ],
  hours_timezone_sources: [
    'agency/softphone.ts#AgencySoftphoneOutsideHoursRefusal.timezone_source',
    () => fieldUnion('agency/softphone.ts', 'AgencySoftphoneOutsideHoursRefusal', 'timezone_source'),
  ],
  call_availabilities: [
    'api/agency/attempt-call.ts#AgencyCallAvailability',
    () => typeUnion('api/agency/attempt-call.ts', 'AgencyCallAvailability'),
  ],
  session_refusal_codes: [
    'api/platform/auth.ts#SESSION_REFUSAL_CODES',
    () => constList('api/platform/auth.ts', 'SESSION_REFUSAL_CODES'),
  ],
  user_statuses: ['api/platform/auth.ts#User.status', () => fieldUnion('api/platform/auth.ts', 'User', 'status')],
  tenant_statuses: ['api/platform/auth.ts#Tenant.status', () => fieldUnion('api/platform/auth.ts', 'Tenant', 'status')],
  membership_statuses: [
    'api/platform/auth.ts#Membership.status',
    () => fieldUnion('api/platform/auth.ts', 'Membership', 'status'),
  ],
  notification_cadences: [
    'api/platform/notifications.ts#NotificationCadence',
    () => typeUnion('api/platform/notifications.ts', 'NotificationCadence'),
  ],
  notification_frequencies: [
    'api/platform/notifications.ts#NotificationFrequency',
    () => typeUnion('api/platform/notifications.ts', 'NotificationFrequency'),
  ],
  // Contact assignment: the agent's queue, own contacts and retry.
  assignment_modes: ['agency/assignment.ts#AGENCY_ASSIGNMENT_MODES', () => constList('agency/assignment.ts', 'AGENCY_ASSIGNMENT_MODES')],
  queue_idle_reasons: ['agency/station.ts#AgencyQueueIdleReason', () => typeUnion('agency/station.ts', 'AgencyQueueIdleReason')],
  override_kinds: ['agency/session.ts#AGENCY_OVERRIDE_KINDS', () => constList('agency/session.ts', 'AGENCY_OVERRIDE_KINDS')],
  my_contact_buckets: [
    'api/agency/assignment.ts#AGENCY_MY_CONTACT_BUCKETS',
    () => constList('api/agency/assignment.ts', 'AGENCY_MY_CONTACT_BUCKETS'),
  ],
  agent_retry_blocks: [
    'api/agency/assignment.ts#AGENCY_AGENT_RETRY_BLOCKS',
    () => constList('api/agency/assignment.ts', 'AGENCY_AGENT_RETRY_BLOCKS'),
  ],
  agent_retry_error_codes: [
    'api/agency/assignment.ts#AGENCY_AGENT_RETRY_ERROR_CODES',
    () => constList('api/agency/assignment.ts', 'AGENCY_AGENT_RETRY_ERROR_CODES'),
  ],
  // Customer history: one number across the tenant's campaigns (docs/customer-history.md).
  customer_search_bys: [
    'api/agency/customer-history.ts#CUSTOMER_SEARCH_BYS',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_SEARCH_BYS'),
  ],
  customer_timeline_channels: [
    'api/agency/customer-history.ts#CUSTOMER_TIMELINE_CHANNELS',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_TIMELINE_CHANNELS'),
  ],
  customer_timeline_kinds: [
    'api/agency/customer-history.ts#CUSTOMER_TIMELINE_KINDS',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_TIMELINE_KINDS'),
  ],
  customer_recording_states: [
    'api/agency/customer-history.ts#CUSTOMER_RECORDING_STATES',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_RECORDING_STATES'),
  ],
  customer_callback_statuses: [
    'api/agency/customer-history.ts#CUSTOMER_CALLBACK_STATUSES',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_CALLBACK_STATUSES'),
  ],
  customer_search_number_errors: [
    'api/agency/customer-history.ts#CUSTOMER_SEARCH_NUMBER_ERRORS',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_SEARCH_NUMBER_ERRORS'),
  ],
  customer_history_error_codes: [
    'api/agency/customer-history.ts#CUSTOMER_HISTORY_ERROR_CODES',
    () => constList('api/agency/customer-history.ts', 'CUSTOMER_HISTORY_ERROR_CODES'),
  ],
};

/** The JSON document, as it should be committed. */
export function buildLiterals() {
  sources.clear();
  const doc = {
    _comment:
      'Generated by tooling/contracts-literals.mjs from packages/contracts/src. Do not edit; '
      + 'run `node tooling/contracts-literals.mjs`. The agency_wire Dart suite fails on any literal its enums do not know.',
  };
  for (const [key, [from, read]] of Object.entries(VOCABULARIES)) {
    doc[key] = { source: `packages/contracts/src/${from}`, values: read() };
  }
  return doc;
}

export function renderLiterals(doc = buildLiterals()) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(argv) {
  const want = renderLiterals();
  const rel = relative(ROOT, LITERALS_PATH);
  if (argv.includes('--check')) {
    let have = '';
    try {
      have = readFileSync(LITERALS_PATH, 'utf8');
    } catch {
      // a missing file is stale
    }
    if (have !== want) {
      console.error(`${rel} is stale. Run: node tooling/contracts-literals.mjs`);
      process.exit(1);
    }
    console.log(`${rel} is up to date (${Object.keys(VOCABULARIES).length} vocabularies).`);
    return;
  }
  writeFileSync(LITERALS_PATH, want);
  console.log(`wrote ${rel} (${Object.keys(VOCABULARIES).length} vocabularies)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
