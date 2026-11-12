import styles from '../AgencyCampaignsPage.module.css';

/*
  The three rules every newcomer trips on once: beside the campaign list, and inside the
  getting-started guide when there is no campaign yet. The page used to carry a shortcuts rail
  here too (Analytics, Do Not Call, Team); every one of those is a sidebar or Settings entry under
  the same gate (B28), so it went.
*/
const RULES = [
  'A campaign starts as a draft. Nothing is dialled until you start it.',
  'Several campaigns can run at once. They share your account’s lines.',
  'Stopping a campaign lets calls already in progress finish.',
];

export function Rules() {
  return (
    <ul className={styles.rules} role="list">
      {RULES.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );
}

export function RulesCard() {
  return (
    <section className={styles.railCard} aria-labelledby="campaigns-rules-heading">
      <h2 id="campaigns-rules-heading" className={styles.railTitle}>
        Good to know
      </h2>
      <Rules />
    </section>
  );
}
