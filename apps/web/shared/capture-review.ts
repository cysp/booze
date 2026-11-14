import { catalogueCandidateSchema, type CatalogueCandidate } from "./catalogue-inputs.ts";
import { hasWineIdentity } from "./wine-identity.ts";

export const captureReviewCandidateSchema = catalogueCandidateSchema;
export type CaptureReviewCandidate = CatalogueCandidate;

export function isIdentifiedCapture(candidate: CaptureReviewCandidate): boolean {
  return hasWineIdentity(candidate.wine);
}
