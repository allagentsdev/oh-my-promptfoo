# ADR 0005: Merge local sources that share a destination, and fail on collisions

- Status: Accepted
- Date: 2026-10-21

## Context

A workspace source names a `destination`, a relative path inside the private workspace. Validation rejected a destination that repeated or nested, so one destination had exactly one source. That is the assumption the rest of the provider was built on: one `SourceView` per destination, one seed subtree at `seedPath(digest)/<destination>`, one protected checkout keyed by that source's acquisition identity, one symlink or copy owning the tree, one entry in the recovery record to tear down.

Consumers stage skills from several plugins into `.agents/skills`. With one source per destination the only workaround is one plugin per skill root — `.agents/skills`, then a second and third directory the agent also has to be told about. One consumer is already at exactly three, which is where the workaround stops being a workaround.

The hook this package replaced did merge, by `rmSync` followed by `cpSync` per plugin. Whichever plugin ran last owned any shared path, and nothing said so.

## Decision

A destination may repeat exactly, and the sources that repeat it merge into one tree. The merged tree is still one view: one seed subtree, one checkout, one record entry, one owner. Nothing downstream learns that more than one source contributed.

Three rules make the merged tree a function of the set of sources rather than of acquisition order, and all three are enforced, not documented:

- **Same `permissions`.** One tree cannot be both a protected checkout and a private writable view, so mixing `read-only` and `all` on one destination is rejected.
- **Disjoint entries.** Two sources contributing the same relative path is a configuration error. It fails, naming both source paths and the path they both claim. A directory path may repeat, since merging is the point, but only when the sources agree on its mode — the copy chmods each directory it visits, so a disagreement would be decided by order.
- **Exact repetition only.** `a` against `a/b` stays rejected. A nested pair has no single tree for a view to own; one of the two would have to be materialised inside the other's checkout.

Only `type: local` sources merge. The other two types are refused, each for a reason that merging cannot be made safe around:

- **Git.** A Git destination is not just files. It carries the `.git` that `fileChanges` opens as `--git-dir` with the destination as `--work-tree` to separate tracked edits from generated files. Foreign files merged into that work tree become untracked entries in a repository that never knew about them, which silently changes what the provider reports. Two Git sources would collide on `.git` itself in every case.
- **Prepared (prebuilt) Git.** A prepared source is symlinked straight to an external tree and verified by a stamp over exactly that tree. There is no merged tree to stamp, and the package does not write into the prepared root. This is the one case where merging could not preserve its integrity guarantee, so it is refused rather than weakened.
- **OCI.** An artifact tree is published and digested as a unit. Merging has no requested use here, and letting two registries interleave files into one directory widens the trust surface for nothing.

Two structural consequences follow. `protectedCheckoutKey` now takes the whole group of sources contributing to a destination, so a merged checkout is reused only by exactly the same set; a lone source keeps the key it had, so existing cached checkouts stay valid. `manifestDigest` sorts by destination and then by canonical identity text, because destination alone stopped being a total order once it can repeat; specs with distinct destinations keep the digests they had.

## Consequences

Recovery validation now refuses any record carrying two non-probe views for one destination. That is the invariant the merge rests on, stated where a corrupted or hand-edited record would otherwise be trusted.

A collision is a hard failure at preparation time, not a warning. Two plugins that both ship `common/SKILL.md` cannot be staged together until one of them renames it. That is deliberate: the alternative is the behaviour this change exists to remove.

Collisions are detected from the inventories resolution already hashed, before any byte is written, so the error names both sources rather than surfacing as an `EEXIST` from whichever copy lost the race.

## Rejected alternative: last source wins

Let a later source overwrite an earlier source's path, as the replaced hook did.

It is cheaper and it never fails, and both of those are the problem. Which plugin's `SKILL.md` an agent reads would depend on source order in YAML, and the provider sorts sources by destination before materialising, so "later" is not even the order the author wrote. A shadowed skill produces no diagnostic: the eval runs, the agent reads the wrong file, and the result looks like a model failure. The seed digest would still cover both sources, so two configurations with the same digest could legitimately contain different bytes if ordering ever changed — the cache would be keyed by something that no longer determines its contents.

Ordering the merge deterministically (say, by source path) would fix the cache but not the diagnosis. The author would still have no signal that one of their plugins is inert.

## Rejected alternative: a `merge: true` opt-in

Require an explicit flag before sharing a destination.

The flag would have nothing to switch on. Merging without collisions is the only behaviour on offer; with collisions it fails either way. A flag whose `false` value means "reject a configuration that would otherwise have worked" is a second way to spell a configuration error.
