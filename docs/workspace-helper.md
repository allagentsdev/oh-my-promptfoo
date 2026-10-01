# Linux bounded staging helper

The optional administrator-installed helper mounts only capacity-bounded tmpfs for Git acquisition. Workspace views never need mount privilege: `auto` tries verified unprivileged reflinks then disk-admitted full copies, and `copy-only` uses admitted physical copies without reflink probes. Protected read-only checkouts are copied once per source identity in `copy-only`; the copy consumes peak disk in addition to the immutable seed. Neither mode mounts OverlayFS.

Install the reviewed helper once:

```sh
sudo install -o root -g root -m 0755 scripts/workspace-helper.py /usr/local/libexec/allagents-workspace-helper
```

Grant the evaluation account only the two bounded staging operations, for example with a dedicated `allagents` group and a sudoers file validated using `visudo`:

```sudoers
%allagents ALL=(root) NOPASSWD: /usr/local/libexec/allagents-workspace-helper acquire-tmpfs *, /usr/local/libexec/allagents-workspace-helper release-tmpfs *
```

The helper checks caller-owned cache markers and directory ownership, opens every ancestor without following links, and pins directory descriptors before mounting. tmpfs mounts must be under cache `staging/` and have an explicit capacity at most 50 GiB. Package admission reserves their capacity before acquisition. No caller-provided executable or mount option is accepted. Release accepts only an unambiguous helper-labeled tmpfs; failed release preserves recovery state and leases. The provider must see the mount in its own namespace.

For a no-sudo runner, set `ALLAGENTS_NO_PRIVILEGED_HELPER=1` and supply a private pre-mounted bounded tmpfs through `ALLAGENTS_GIT_STAGING_ROOT` for HTTPS Git. If this is unavailable, remote acquisition fails closed before Git writes. With the reviewed helper, `file://` Git uses a capacity-bounded native checkout and copies the verified result into an independent seed; without the helper it uses bounded parent-controlled Git object reconstruction.

Cache locks use Linux `flock`. macOS uses native advisory locks through system Python 3 from Xcode command line tools. Windows uses named kernel mutexes through Windows PowerShell; the process must be able to launch the system PowerShell executable. A missing lock backend fails explicitly. Kernel ownership is released on process death.
