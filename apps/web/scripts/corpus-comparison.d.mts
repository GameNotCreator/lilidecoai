export interface CaseRecord {
  caseId: string;
  stratum: string;
  status: string;
  sourceDigest: string | null;
  engineVersions?: { mockMode?: boolean };
  signals?: { quality?: string };
  referenceFiles?: Record<string, string>;
}
export interface Report {
  split: string;
  server: { mockMode: boolean };
  cases: CaseRecord[];
}
export interface Pair {
  id: string;
  caseId: string;
  stratum: string;
  sourceDigest: string;
  arms: Record<"A" | "B", "baseline" | "candidate">;
  records: Record<"baseline" | "candidate", CaseRecord>;
}
export interface Verdict {
  pair: string;
  arm: string;
  usable: boolean | null;
  identityCritical: boolean | null;
  occlusionCritical: boolean | null;
  realism: number | null;
}
export interface Sheet {
  evaluator: string;
  items: Verdict[];
}
export interface Score {
  inputs: number;
  delivered: number;
  judged: number;
  usable: number;
  criticalIdentity: number;
  criticalOcclusion: number;
  unknown: number;
  realismTotal: number;
  usefulInputRate: number | null;
  usefulDeliveryRate: number | null;
  meanRealism: number | null;
}
export const SPLITS: string[];
export function eligibleSplit(item: { split?: string }, split: string): boolean;
export function sourceDigest(
  item: Record<string, unknown>,
  directory: string,
): Promise<string>;
export function pairReports(
  baseline: Report,
  candidate: Report,
  coin?: () => number,
): Pair[];
export function compareVerdicts(
  key: { split: string; pairs: Pair[] },
  first: Sheet,
  second: Sheet,
  arbitration?: Sheet,
): {
  split: string;
  pairCount: number;
  unresolved: string[];
  totals: Record<
    "supported" | "experimental",
    Record<"baseline" | "candidate", Score>
  >;
  complete: boolean;
  productionValidated: false;
};
