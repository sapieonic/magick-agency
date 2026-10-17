import { Link } from 'react-router-dom';
import { ListChecks, Phone, Plus, Upload, UserPlus, type LucideIcon } from 'lucide-react';
import { WorkspaceExit } from '../../../components/agency/WorkspaceExit';
import { Rules } from './Shortcuts';
import styles from '../AgencyCampaignsPage.module.css';

const STEPS: Array<{ title: string; text: string; icon: LucideIcon }> = [
  {
    title: 'Create the campaign',
    text: 'Name it, choose the numbers it dials from, and set its calling hours.',
    icon: ListChecks,
  },
  {
    title: 'Add contacts',
    text: 'Upload a CSV roster and map its columns to the contact fields.',
    icon: Upload,
  },
  {
    title: 'Assign agents',
    text: 'Invite your agents to the team and staff them on the campaign.',
    icon: UserPlus,
  },
  {
    title: 'Start dialing',
    text: 'Agents join from the agent station, and answered calls go straight to them.',
    icon: Phone,
  },
];

export function GetStarted({ canCreate, canInvite }: { canCreate: boolean; canInvite: boolean }) {
  return (
    <section className={styles.welcome} aria-labelledby="campaigns-welcome-heading">
      <div className={styles.welcomeHero}>
        <span className={styles.welcomeIcon} aria-hidden="true">
          <ListChecks size={22} />
        </span>
        <h2 id="campaigns-welcome-heading" className={styles.welcomeTitle}>
          {canCreate ? 'Launch your first campaign' : 'No campaigns yet'}
        </h2>
        <p className={styles.welcomeText}>
          {canCreate
            ? 'A campaign works through a list of contacts and hands every answered call to an agent who is ready for it. Setting one up takes a few minutes.'
            : 'Campaigns are set up by a supervisor. They will show here as soon as one exists.'}
        </p>
        {canCreate && (
          <div className={styles.welcomeActions}>
            <Link to="/agency/campaigns/new" className="btn-primary">
              <Plus size={16} aria-hidden="true" />
              New campaign
            </Link>
            {/* Lands on Team: see the note on `SHORTCUTS`. */}
            {canInvite && (
              <WorkspaceExit className="btn-secondary">
                <UserPlus size={16} aria-hidden="true" />
                Invite agents
              </WorkspaceExit>
            )}
          </div>
        )}
      </div>

      {/* The steps are instructions, so only a role that can follow them gets them. */}
      {canCreate && (
        <ol className={styles.steps} role="list">
          {STEPS.map((step, i) => (
            <li key={step.title} className={styles.step}>
              <div className={styles.stepHead}>
                <span className={styles.stepNumber}>{i + 1}</span>
                <step.icon size={16} className={styles.stepIcon} aria-hidden="true" />
              </div>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepText}>{step.text}</p>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.welcomeRules}>
        <h3 className={styles.railTitle}>Good to know</h3>
        <Rules />
      </div>
    </section>
  );
}
