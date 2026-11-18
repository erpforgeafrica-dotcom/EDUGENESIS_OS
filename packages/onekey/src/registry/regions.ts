/**
 * Adapter regions allowlist (Doc 09 §12.7).
 *
 * WHY deny-by-default: a data-residency breach is a governance incident. An
 * adapter may only serve in a region the deployment has explicitly approved;
 * an absent, empty or unknown region is refused rather than assumed safe.
 * This is a routing eligibility record, paired with the deny-by-default egress
 * payload allowlist — it never becomes a sponsor routing preference.
 */

export interface RegionAllowlist {
  /** The normalised regions that were explicitly approved. */
  readonly allowed: readonly string[];
  /** True only for an explicitly approved, well-formed region. */
  allows(region: string | undefined): boolean;
}

/** Build a deny-by-default allowlist. Matching is case-insensitive. */
export function createRegionAllowlist(regions: readonly string[]): RegionAllowlist {
  const allowed = regions.map((region) => region.trim().toLowerCase()).filter((region) => region.length > 0);
  return {
    allowed,
    allows(region: string | undefined): boolean {
      if (typeof region !== 'string') {
        return false;
      }
      const normalised = region.trim().toLowerCase();
      return normalised.length > 0 && allowed.includes(normalised);
    },
  };
}

/** Refuse a region that is not explicitly approved. */
export function assertRegionAllowed(list: RegionAllowlist, region: string | undefined): void {
  if (!list.allows(region)) {
    throw new Error(`region '${region ?? 'unspecified'}' is not in the adapter allowlist`);
  }
}
