/**
 * The console-facing agency HTTP/WS wire shapes, as one
 * module. Re-exported from the package root as the `AgencyApi` namespace; also
 * importable per file, e.g. `@magick-agency/contracts/api/agency/agency-stats`.
 *
 * These are what the merged server must RETURN to the console — not the same as
 * the dialer runtime contract at the package root (`../../agency`), even where a name is
 * shared.
 */

export * from './agency';
export * from './agency-campaign';
export * from './agency-spine';
export * from './call-log';
export * from './agency-stats';
export * from './agency-activity';
export * from './agency-campaign-series';
export * from './dnc';
export * from './call-analysis-profile';
export * from './webrtc-call';
export * from './attempt-call';
export * from './softphone';
export * from './assignment';
export * from './agent-caller-id';
export * from './insights';
export * from './customer-history';
export * from './reports';
export * from './compare';
export * from './inbound';
export * from './live-calls';
export * from './listen-history';
export * from './home';
export * from './floor';
export * from './promises';
export * from './callbacks';
export * from './my-day';
export * from './shared';
