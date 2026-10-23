import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { CueSettings } from './CueSettings';
import { StationIdentity, type StationIdentityUser } from './StationIdentity';
import { StationMenu } from './StationMenu';
import { ConnectionHealthPill } from './ConnectionHealthPill';
import type { CuePrefs } from '../../utils/agencyCuePrefs';
import type { StationConnection } from '../../hooks/useAgencyStation';
import type { AgencyAgentState } from '../../types/agency';
import styles from './AgentStation.module.css';

/**
 * The station's header: who is on it, what is being disclosed (recording,
 * muted), cue settings, the way out, and the connection.
 *
 * Nothing here acts on the call — that is the action bar's, whose sequence is a
 * tab-order guarantee — which is the reasoning each control below gives for
 * living here.
 */
export function StationHeader({
  user,
  campaignName,
  recordCalls,
  muted,
  cuePrefs,
  onCuePrefsChange,
  agentState,
  canExit,
  leaving,
  onLeave,
  onExit,
  connection,
  missedPings,
}: {
  user: StationIdentityUser | null | undefined;
  /** Null while the bootstrap is still loading. */
  campaignName: string | null | undefined;
  recordCalls: boolean;
  muted: boolean;
  cuePrefs: CuePrefs;
  onCuePrefsChange: (next: CuePrefs) => void;
  agentState: AgencyAgentState;
  canExit: boolean;
  leaving: boolean;
  onLeave: () => void;
  onExit: () => void;
  connection: StationConnection;
  missedPings: number;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <StationIdentity user={user} subline={campaignName ?? 'Loading…'} />
      </div>
      <div className={styles.headerRight}>
        {/* Recording is disclosed as a dot PLUS the word — in several
            jurisdictions the agent must announce it, and they cannot announce
            what they cannot see. */}
        {recordCalls ? (
          <span className={styles.recording}>
            <span className={styles.recordingDot} aria-hidden="true" />
            Recording
          </span>
        ) : null}
        {/* Muted is disclosed in the header as well as on the button. An agent
            who has to look at a toggle to find out whether they are audible
            will not look, and the failure is a customer hearing nothing while
            the talk timer runs — the exact shape of the bug the audio path
            was built to remove. */}
        {muted ? (
          <span className={styles.muted} data-testid="muted-pill">
            <span className={styles.mutedDot} aria-hidden="true" />
            Muted
          </span>
        ) : null}
        {/*
          Cue settings live in the header, not the action bar.

          Two reasons, both about the agent rather than the layout. It is a
          **display** preference and not a call action's action-bar
          sequence (Break → Save → … → Hang up) is the set of things that act on
          a live call, and a control that changes how the console looks does not
          belong between Mark DNC and Hang up. And it must be reachable in two
          keystrokes from a cold start: the agent most likely to need it is the
          one who cannot hear the cues, and making them Tab past the whole
          contact panel to find the switch is the same "operable but effectively
          unreachable" shape this guards against.
        */}
        <CueSettings prefs={cuePrefs} onChange={onCuePrefsChange} />
        {/*
          The way OUT of the station, beside cue settings and deliberately not
          in the action bar: fixes that bar's sequence (Break → Save →
          … → Hang up) as a tab-order guarantee, and an item inserted there
          moves controls an agent reaches by muscle memory — the neighbour
          being the one that hangs up on a person. Leaving is also not a call
          action, which is the same reasoning that put cue settings here.
        */}
        <StationMenu
          agentState={agentState}
          canExit={canExit}
          leaving={leaving}
          onLeave={onLeave}
          onExit={onExit}
        />
        <ConnectionHealthPill connection={connection} missedPings={missedPings} />
        {/* The station has no sidebar; the release version sits at the end of its one bar of
            chrome. A plain label: nothing to focus, so no control moves. */}
        <AppVersion version={__APP_VERSION__} variant="inline" />
      </div>
    </header>
  );
}
