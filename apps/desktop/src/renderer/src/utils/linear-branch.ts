// Re-export the canonical, shared implementation so renderer imports and the
// existing unit tests keep working while main can consume the same logic.
export { extractLinearIdentifier, buildLinkedBranchName, slugifyForBranch } from '../../../shared/linear-branch'
