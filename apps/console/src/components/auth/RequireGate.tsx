import type { ReactNode } from 'react';
import type { Gate } from '../../utils/consoleNav';
import RequireCapability from './RequireCapability';
import RequireFlag from './RequireFlag';

/**
 * A route's guards, read from the gate its navigation entry is offered under (`utils/consoleNav`),
 * so the link and the route cannot drift apart: each capability (`RequireCapability`), then each
 * flag (`RequireFlag`), outermost first. Only those: the permission is the page's to check (it says
 * what it says to a reader it refuses), and the rest of a gate decides whether to offer a link.
 */
export default function RequireGate({ gate, children }: { gate: Gate; children: ReactNode }) {
  const flagged = (gate.flags ?? []).reduceRight<ReactNode>(
    (inner, flag) => <RequireFlag flag={flag}>{inner}</RequireFlag>,
    children,
  );
  return (
    <>
      {(gate.capabilities ?? []).reduceRight<ReactNode>(
        (inner, capability) => <RequireCapability capability={capability}>{inner}</RequireCapability>,
        flagged,
      )}
    </>
  );
}
