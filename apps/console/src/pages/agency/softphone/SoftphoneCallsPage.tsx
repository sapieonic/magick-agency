import { Phone } from 'lucide-react';
import { PageDescription } from '../../../components/common/PageDescription';
import { SoftphoneCallsList } from '../../../components/softphone/SoftphoneCallsList';
import spine from '../../../components/agency/SpineListLayout.module.css';
import styles from '../AgencyCampaignAttemptsPage.module.css';

export const SOFTPHONE_CALLS_DESCRIPTION =
  'Every call agents placed from the soft phone — logged to a campaign or not — with the outcome they saved. '
  + 'Soft-phone calls are not paced and never count toward a campaign’s attempts.';

/**
 * `/agency/softphone` — the supervisor's "Soft-phone calls" (`docs/softphone.md`
 * §7): every manual call in the account, filterable by day, agent, the campaign
 * it was logged to (or "Not logged"), what happened and the number, newest first,
 * each row opening the call's detail.
 *
 * No extra guard: the `/agency` subtree is gated on the `agency` capability and
 * `agency_dialer_enabled`, the route on `agency_softphone_enabled`, and the
 * server scopes `GET /softphone/calls` to the whole account only for
 * `agency.supervise` — which is also what the sidebar entry checks.
 */
export default function SoftphoneCallsPage() {
  return (
    <div className={styles.page}>
      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true">
            <Phone size={20} />
          </span>
          <h1 className={spine.title}>Soft-phone calls</h1>
        </div>
      </header>
      <PageDescription
        pageKey="agency-softphone-calls"
        description={SOFTPHONE_CALLS_DESCRIPTION}
        tips={[
          'A call logged to a campaign uses that campaign’s outcomes; one that is not uses the soft phone’s own.',
          'DNC and calling-hours overrides are marked on the row; open the call to read the agent’s reason.',
          'The numbers above the table count the calls listed — load older calls to include them.',
        ]}
      />
      <SoftphoneCallsList
        scope="account"
        defaultToday
        detailPath={(call) => `/agency/softphone/calls/${call.id}`}
        caption="Soft-phone calls in this account, newest first"
      />
    </div>
  );
}
