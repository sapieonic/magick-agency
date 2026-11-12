/** Types for `contracts-literals.mjs`, so the contracts Vitest suite can import it under `tsc`. */

export interface LiteralVocabulary {
  /** `packages/contracts/src/<file>#<declaration>`. */
  source: string;
  /** A list of literals, or (close codes) a name → code map. */
  values: string[] | Record<string, number>;
}

export type LiteralsDocument = { _comment: string } & Record<string, LiteralVocabulary | string>;

export const LITERALS_PATH: string;
export function stripComments(text: string): string;
export function buildLiterals(): LiteralsDocument;
export function renderLiterals(doc?: LiteralsDocument): string;

export interface LabelMap {
  /** `packages/contracts/src/<file>#<declaration>`. */
  source: string;
  /** Each wire value's label. */
  labels: Record<string, string>;
}

export type LabelsDocument = { _comment: string } & Record<string, LabelMap | string>;

export const LABELS_PATH: string;
export function buildLabels(): LabelsDocument;
