import { CircleCheck, Info, MessageSquare } from 'lucide-react';
import type { UseAgencyStationResult } from '../../../hooks/useAgencyStation';
import type { StationHelp } from '../../../pages/agency/station/useStationHelp';
import { messageSender } from '../../../utils/agency/stationHelp';
import { STATION_COPY, helpAnsweredLine, helpRefusedLine } from '../../../utils/agency/stationCopy';
import { clockTime } from '../../../utils/agency/stationFormat';
import { StationBanner } from './StationFrame';
import styles from './Station.module.css';

/**
 * The supervisor line (spec 02b), under the band on every screen of the station and the soft phone
 * page: a supervisor's message, one at a time with the rest counted, OK showing the next (LF5,
 * LF36's rule for a soft-phone session); else what became of a help request (answered, lapsed) or
 * why the agent's last press was refused. Nothing when there is none of these.
 */
export function SupervisorBanner({
  station,
  help,
}: {
  station: Pick<UseAgencyStationResult, 'supervisorMessages' | 'helpNotice' | 'dismissSupervisorMessage'>;
  help: StationHelp;
}) {
  const message = station.supervisorMessages[0] ?? null;
  const helpNotice = station.helpNotice;
  const helpRefusal = help.refusalKind ? helpRefusedLine(help.refusalKind) : null;
  if (message) {
    const sentAt = Date.parse(message.sent_at);
    return (
      <StationBanner
        message
        icon={<MessageSquare size={22} />}
        testId="supervisor-message"
        action={
          <button type="button" className={styles.btn} onClick={() => station.dismissSupervisorMessage(message.id)} data-testid="supervisor-message-ok">
            {STATION_COPY.messageOk}
          </button>
        }
      >
        <small>
          <strong>{messageSender(message.from_name)}</strong> {STATION_COPY.supervisorSuffix}
          {Number.isNaN(sentAt) ? null : <> · <time dateTime={message.sent_at}>{clockTime(sentAt)}</time></>}
        </small>
        <p data-testid="supervisor-message-text">{message.text}</p>
        {station.supervisorMessages.length > 1 ? (
          <small data-testid="supervisor-messages-more">{STATION_COPY.moreMessages(station.supervisorMessages.length - 1)}</small>
        ) : null}
      </StationBanner>
    );
  }
  if (helpRefusal) {
    return (
      <StationBanner tone="problem" icon={<Info size={22} />} role="status" testId="need-help-refusal">
        {helpRefusal}
      </StationBanner>
    );
  }
  if (helpNotice) {
    return (
      <StationBanner
        tone={helpNotice.kind === 'answered' ? 'ready' : 'quiet'}
        icon={helpNotice.kind === 'answered' ? <CircleCheck size={22} /> : <Info size={22} />}
        testId="need-help-status"
        action={help.dismissible ? (
          <button type="button" className={styles.btn} onClick={help.dismiss} data-testid="need-help-dismiss">{STATION_COPY.messageOk}</button>
        ) : undefined}
      >
        {helpNotice.kind === 'expired' ? STATION_COPY.helpExpired : helpAnsweredLine(helpNotice.by_name, helpNotice.how)}
      </StationBanner>
    );
  }
  return null;
}
