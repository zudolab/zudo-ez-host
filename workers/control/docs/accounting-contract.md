# Publication accounting contract

This contract defines the D1 accounting state that every prepare, upload,
expiry, abandonment, and commit implementation must preserve. Byte values are
non-negative integers. Content objects are project-scoped, so reuse is deduced
within a project and never across projects or users.

## Counters and limits

The `user` row is the serialization point for quota changes. Its counters have
these meanings:

- **Active logical bytes** are the sum of the logical byte count of every
  current project head owned by the user. Manifest paths are counted, so two
  paths that reference one hash count twice. The V1 maximum is 10 GiB.
- **Reserved active delta** is the sum, over open attempts, of
  `max(0, attempted logical bytes - base head logical bytes)`. It reserves only
  possible growth; shrinkage is applied only by a successful commit. Prepare
  requires `active logical + reserved active delta <= 10 GiB`.
- **Unique retained/staged physical bytes** are the sum of the sizes of
  distinct verified project-scoped content objects that are reachable from an
  open attempt or a retained immutable publication, including current heads.
  A hash is counted once per project even when it appears at multiple paths,
  attempts, or generations. The V1 maximum for this counter plus reserved
  physical upload bytes is 20 GiB.
- **Reserved physical upload bytes** are the sum, over open attempts, of the
  sizes of distinct required project-scoped hashes that were absent from the
  verified-object inventory at prepare time and remain reserved for upload.
  Duplicate manifest paths never create duplicate reservations.

The per-attempt reservation columns are the source of truth for releasing that
attempt's share. Counters must not be reconstructed from an untrusted request.
All additions use bounded values validated against the shared V1 limits before
SQL is prepared, and all SQL counter updates guard against negative results and
limit overflow.

## Attempt state machine

`publication_attempts.state` has four terminally ordered values:

```text
                     commit (head CAS succeeds)
prepare -> open ---------------------------------> committed
             |                                      terminal
             +-- expiry sweep -------------------> expired
             |                                      terminal
             +-- authenticated abandon ----------> abandoned
                                                    terminal
```

- **Prepare** derives the user from the authenticated machine, derives the
  canonical handle from that `user` row, captures the current project-head
  generation and logical bytes, records one attempt-object row per distinct
  content hash, and creates an `open` attempt. In the same guarded batch it
  adds the attempt's active-delta and missing-physical reservations to the user
  counters. The attempt owns an immutable staged-manifest R2 key and manifest
  hash; later requests cannot replace them.
- **Upload verification** applies only to an `open`, unexpired attempt. A newly
  verified object is inserted into the project-scoped inventory with its
  immutable size, its attempt-object is marked verified, and the corresponding
  physical reservation moves from `reserved physical upload bytes` to `unique
retained/staged physical bytes`. If the inventory row already exists at the
  same size, the object is reuse and no physical bytes move. A hash with a
  conflicting size is an integrity failure.
- **Expiry** is an idempotent `open -> expired` transition performed when
  `expiresAt <= now`. It releases that attempt's remaining active and physical
  reservations exactly once. An expiry sweep may later garbage-collect objects
  only after proving they are unreachable from every open attempt and retained
  publication; only then may it decrement unique physical bytes.
- **Abandon** is the authenticated, idempotent `open -> abandoned` transition.
  It releases reservations under the same rules as expiry. It never mutates a
  publication or project head.
- **Commit** is `open -> committed` only after every attempt object and the
  staged canonical manifest have been verified. It succeeds only when the
  mutable head still has the captured `baseGeneration`. The guarded batch
  creates the immutable publication and its unique object references, advances
  the head, changes active logical bytes by `new logical - prior-head logical`,
  releases the attempt's active and remaining physical reservations, and
  terminally marks the attempt. A stale head leaves the attempt open so the
  caller can explicitly abandon it; it never partially promotes content.

Terminal attempts never transition again. Repeating expiry or abandonment is a
no-op; repeating commit resolves through the immutable publication attached to
the attempt and returns the same generation. An attempt ID can own at most one
publication, providing cross-generation commit idempotency without treating a
manifest hash as an idempotency key.

## Settlement edge cases

### Head replacement

On commit, the old head's logical bytes leave `active logical bytes` and the
new head's logical bytes enter it. The old immutable publication and its object
references remain retained for rollback, so their physical bytes do not leave
the unique physical counter. The committed attempt's active-delta reservation
is released in full even if the new head is smaller.

### Content-hash reuse

Prepare joins distinct required hashes against `verified_objects`. Existing
hashes with the same size reserve zero upload bytes. Commit adds publication
references but not inventory rows or physical bytes for reused content. Reuse
works across attempts and retained generations of the same project.

### Duplicate manifest paths

Logical bytes and file counts follow manifest paths: two paths referencing a
100-byte object contribute 200 active logical bytes and two files. Attempt and
publication object-reference tables are keyed by `(attempt/publication, hash)`,
so they contain one 100-byte physical reference and reserve/count it once.

## Ownership, identity, and immutability

- The owner table is named `user`; `account` remains available to Better Auth
  for provider links. A user's canonical handle is stored only on `user`.
- Project, machine, attempt, publication, inventory, and head authorization is
  derived through opaque IDs and foreign-key ownership joins. Handles, slugs,
  hostnames, machine names, and request-supplied owner IDs are never authority.
- A hostname allocation is built from the stored canonical handle and stored
  project slug. Its permanent label maps to opaque user/project IDs. Allocation
  rows use restrictive foreign keys and are never updated, deleted, cascaded,
  or reassigned, including after project takedown.
- Publications and publication-object rows are immutable. A publication stores
  the stable machine ID and a machine-name snapshot; renaming or revoking the
  machine cannot rewrite history. Only `project_heads` is mutable.

## D1 guarded-write discipline

D1 `batch()` executes prepared statements sequentially as a transaction, but a
conditional statement that affects zero rows is still successful. Every
conditional `UPDATE`, `INSERT ... SELECT`, or `DELETE` is therefore registered
with an exact expected `meta.changes` count and checked after `batch()`.

Dependent statements must also repeat the ownership, state, expiry, generation,
and quota predicates they rely on. They must not assume that a prior statement
matched merely because the batch did not throw. The reusable guarded-batch
helper rejects the operation if any statement reports an unexpected change
count and identifies the failed guard. This rejection is the operation outcome;
callers must not return success or perform R2 side effects. Batch-level SQL
errors still roll the transaction back normally.

Reads and writes use prepared statements with bound parameters. Migration test
helpers execute only committed, bounded migration files against the workerd D1
binding; application requests never accept raw SQL or migration paths.
