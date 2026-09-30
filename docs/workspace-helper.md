# Linux workspace mount helper

Reflinks need a compatible filesystem. On Linux, OverlayFS and capacity-bounded remote Git staging use an administrator-installed helper when the ordinary provider cannot mount. The provider invokes only `/usr/local/libexec/allagents-workspace-helper`; it never grants itself unrestricted `sudo mount` or `sudo umount`.

Install the reviewed helper once:

```sh
sudo install -o root -g root -m 0755 scripts/workspace-helper.py /usr/local/libexec/allagents-workspace-helper
```

Grant the evaluation account access to this executable, for example with a dedicated `allagents` group and a sudoers file validated using `visudo`:

```sudoers
%allagents ALL=(root) NOPASSWD: /usr/local/libexec/allagents-workspace-helper acquire-tmpfs *, /usr/local/libexec/allagents-workspace-helper release-tmpfs *, /usr/local/libexec/allagents-workspace-helper mount-overlay *, /usr/local/libexec/allagents-workspace-helper release-overlay *
```

The helper accepts exactly four operations, checks caller-owned package markers and directory ownership, opens every ancestor without following links, and pins directory descriptors before mounting. Overlay lower paths must be inside immutable `published/` seeds; upper, work and mount directories must be in the caller's separate marked runtime root. tmpfs mounts must be under cache `staging/` and have an explicit capacity at most 50 GiB. Package admission reserves their capacity before acquisition. No caller-provided executable or mount option is accepted.

Each OverlayFS mount carries a source label derived from its target, lower, upper and work paths. Release verifies that label and the filesystem type against the recorded view before unmounting; a different live mount leaves its record and leases intact. The ordinary-user fallback applies the same identity check when the fixed helper is not installed. Release passes the lower path again so the helper can validate its immutable-cache containment even after a process restart.

Unmounting closes the descriptor held inside the mounted filesystem and calls `umount2` through a pinned parent descriptor with `UMOUNT_NOFOLLOW`. Overlay kernel work directories are returned to their owning user only after successful detach; root-owned files are unlinked as private references, never reassigned through possible hardlinks. Failed detach preserves records and leases. The provider checks its own mount namespace, so a helper deployed in a separate mount namespace cannot pass the probe.

Overlay mounts enable `metacopy=on`. The provider restores writable modes in the private view while the underlying seed stays protected; mode changes copy metadata instead of every source file's contents. A write to an existing file may still copy that entire file, as dictated by OverlayFS. Probes exercise two sibling mounts, modify existing content, verify unchanged seed and sibling bytes, and detach both before selecting the adapter. Pending recovery records exist before each probe and row mount.

Missing helper, missing privilege, unsupported OverlayFS or failed probes lead to bounded recursive copy for affordable writable views. Remote HTTPS Git acquisition fails before launching a writer when its aggregate tmpfs bound is unavailable. With the reviewed helper, `file://` Git uses a capacity-bounded native checkout and copies the verified result into an independent seed; without the helper it uses bounded parent-controlled Git object reconstruction. Large writable repositories require a real CoW lifecycle proof before rollout.

Cache locks use Linux `flock`. macOS uses native advisory locks through system Python 3 from Xcode command line tools. Windows uses named kernel mutexes through Windows PowerShell; the process must be able to launch the system PowerShell executable. A missing lock backend fails explicitly. Kernel ownership is released on process death.
