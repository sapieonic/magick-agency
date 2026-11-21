import { Link } from 'react-router-dom';
import { ArrowUpRight, Headphones, Share2 } from 'lucide-react';
import type { AgencyCompareOutcomeCode, AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import {
  emptyFindingsNote,
  findingCopy,
  neutralNote,
  notClearLine,
  type FindingAction,
} from '../../../utils/agency/compare/compareFindingsCopy';
import styles from './Compare.module.css';

/**
 * What stands out (`docs/compare-agents.md` §2 item 4, §6): at most what the server sent, each
 * finding with its reason under Why this? and a next step that opens a page that exists; then Not
 * clear yet, with Check a longer window; then the metrics shown for context only. The words are
 * the console's (`compareFindingsCopy.ts`); the server sends codes and numbers (CP12).
 */
export interface CompareFindingsProps {
  response: AgencyCompareResponse;
  codes: readonly AgencyCompareOutcomeCode[];
  timezone: string;
  canListen: boolean;
  /** Check a longer window; absent when the window is already as long as allowed. */
  onLonger?: () => void;
}

function ActionIcon({ action }: { action: FindingAction }) {
  if (action.step === 'share_best_call') return <Share2 size={14} aria-hidden="true" />;
  if (action.step === 'listen_recent' || action.step === 'listen_outcome') return <Headphones size={14} aria-hidden="true" />;
  return <ArrowUpRight size={14} aria-hidden="true" />;
}

export function CompareFindings({ response, codes, timezone, canListen, onLonger }: CompareFindingsProps) {
  const ctx = { response, codes, timezone, canListen };
  const empty = emptyFindingsNote(response);
  const neutral = neutralNote(response);
  return (
    <>
      <ul className={styles.finds} data-testid="compare-findings">
        {response.findings.map((finding, i) => {
          const copy = findingCopy(finding, ctx);
          return (
            <li key={`${finding.code}-${finding.agent_user_id}-${finding.metric}-${i}`} className={styles.find} data-testid="compare-finding" data-code={finding.code}>
              <div className={styles.findTop}>
                <span className={styles.badge} data-tone={copy.tone}>
                  {copy.badge}
                </span>
                <p>
                  <strong>{copy.name}</strong>
                  {copy.rest}
                </p>
              </div>
              {copy.why ? (
                <details>
                  <summary>Why this?</summary>
                  <p>{copy.why}</p>
                </details>
              ) : null}
              {copy.action ? (
                <Link className={styles.action} to={copy.action.to} data-testid="compare-finding-action" data-step={copy.action.step}>
                  <ActionIcon action={copy.action} />
                  {copy.action.label}
                </Link>
              ) : null}
            </li>
          );
        })}
        {empty ? (
          <li className={styles.find} data-testid="compare-findings-empty">
            <p className={styles.emptyNote}>
              {empty}
            </p>
            {onLonger && response.findings.length === 0 && /longer window/.test(empty) ? (
              <button type="button" className={styles.linkButton} onClick={onLonger}>
                Check a longer window
              </button>
            ) : null}
          </li>
        ) : null}
      </ul>
      {response.not_clear.length > 0 ? (
        <details className={styles.notClear} data-testid="compare-not-clear">
          <summary>{`Not clear yet (${response.not_clear.length})`}</summary>
          <ul className={styles.notClearList}>
            {response.not_clear.map((f, i) => (
              <li key={`${f.agent_user_id}-${f.metric}-${i}`}>{notClearLine(f, { response })}</li>
            ))}
          </ul>
          <p className={styles.foot}>
            More calls narrow the likely range, so a longer window can show whether these gaps are real.
          </p>
          {onLonger ? (
            <button type="button" className={styles.linkButton} onClick={onLonger} data-testid="compare-longer-window">
              Check a longer window
            </button>
          ) : null}
        </details>
      ) : null}
      {neutral ? <p className={styles.foot}>{neutral}</p> : null}
      <p className={styles.foot}>
        Worked out by fixed rules from the numbers on this page, for coaching. A gap is named only when chance cannot explain it.
      </p>
    </>
  );
}
