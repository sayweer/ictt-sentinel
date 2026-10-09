/**
 * Digest of `docs/PROTOCOL_SOURCE_LOCK.md` the shipped semantics are bound to.
 *
 * Evidence names the source-lock document it was produced under, and a reader
 * checks that name against the document it holds (`check` recomputes it from the
 * repository). A deployed agent has no repository, so it carries the digest as
 * a constant instead. The CLI test suite fails the moment the document changes
 * without this value, so the two cannot drift apart unnoticed.
 */
export const SOURCE_LOCK_DOCUMENT_DIGEST =
  'a920b0ec6e86b0079431f326ca2ac63c8f9400dad3b053c25e5ea72e6aaaef97' as const;
