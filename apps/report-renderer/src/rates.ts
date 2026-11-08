/**
 * Rates the PDF and the workbook both print, derived once so the two files cannot disagree.
 */
import type { AgentReviewDataset } from '@magick-agency/contracts/reports';
import { servedRate, type Rate } from './format';

/** The agent's connect rate as the record serves it, quoted only past the roster's floor. */
export function agentConnectRate(d: AgentReviewDataset): Rate {
  const firstDials = d.daily.reduce((s, r) => s + r.first_dials, 0);
  const reportable = d.roster_row ? d.roster_row.rates_reportable : firstDials >= d.floors.agent_rate_min_first_dials;
  return servedRate(d.record.connect_rate_pct, reportable, firstDials);
}

/** The record's success rate (successes ÷ connected), quoted only past the floor on connected calls. */
export function agentSuccessRate(d: AgentReviewDataset): Rate {
  const reportable = d.roster_row
    ? (d.roster_row.success_rate_reportable ?? d.roster_row.rates_reportable)
    : d.record.connected >= d.floors.agent_rate_min_first_dials;
  return servedRate(d.record.success_rate_pct, reportable, d.record.connected);
}
