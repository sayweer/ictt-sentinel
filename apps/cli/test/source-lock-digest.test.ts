import { describe, expect, it } from 'vitest';
import { SOURCE_LOCK_DOCUMENT_DIGEST } from '@ictt-sentinel/collector';
import { sourceLockHash } from '../src/identity.js';

describe('source-lock digest shipped to the agent', () => {
  it('equals the digest of docs/PROTOCOL_SOURCE_LOCK.md the CLI checks evidence against', () => {
    // Change the document, change the constant: otherwise agent evidence would
    // name a source lock that `check` no longer recognises.
    expect(sourceLockHash()).toBe(SOURCE_LOCK_DOCUMENT_DIGEST);
  });
});
