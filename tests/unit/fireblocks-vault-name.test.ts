import { describe, it, expect } from 'vitest';
import { fireblocksVaultName } from '../../packages/providers/custody/fireblocks/fireblocks';

// Verified against the Fireblocks sandbox 2026-11-07: '/' → "Unexpected error" (901), '·' → "Invalid parameters" (1002).
describe('Fireblocks vault names', () => {
  it('replaces AxLink path separators and drops characters Fireblocks rejects', () => {
    expect(fireblocksVaultName('cmw669laj000001pmbifzzc2t/SANDBOX/Treasury')).toBe('cmw669laj000001pmbifzzc2t - SANDBOX - Treasury');
    expect(fireblocksVaultName('inst/PRODUCTION/Main · €')).toBe('inst - PRODUCTION - Main');
  });
  it('is bounded and never empty', () => {
    expect(fireblocksVaultName('x'.repeat(300))).toHaveLength(100);
    expect(fireblocksVaultName('///')).toBe('- - -');
    expect(fireblocksVaultName('€€')).toBe('AxLink vault');
  });
});
