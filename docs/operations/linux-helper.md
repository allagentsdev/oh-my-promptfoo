# Linux bounded staging helper

Install the optional reviewed helper on a trusted Linux runner only when HTTPS Git cannot use a pre-mounted, capacity-bounded tmpfs supplied through `ALLAGENTS_GIT_STAGING_ROOT`. It is a root-owned administrator capability limited to `acquire-tmpfs` and `release-tmpfs`. Workspace views need no helper: `auto` uses verified reflinks or disk-admitted copies; `copy-only` directly makes independent physical copies for writable views and protected read-only checkouts. Read-only copies consume peak disk beyond the seed. OverlayFS is not supported.

```sh
sudo install -D -o root -g root -m 0755 scripts/workspace-helper.py /usr/local/libexec/allagents-workspace-helper
```

Grant the runner's account only the fixed operations with `sudo visudo -f /etc/sudoers.d/allagents-promptfoo`. Replace `runner` with that account:

```sudoers
runner ALL=(root) NOPASSWD: /usr/local/libexec/allagents-workspace-helper acquire-tmpfs *, /usr/local/libexec/allagents-workspace-helper release-tmpfs *
```

Do not grant `sudo mount`, `sudo umount`, an interpreter, or arbitrary executable overrides. The helper checks package markers, pins every ancestor with `O_NOFOLLOW` directory descriptors, refuses unmarked roots, links, unknown mount types and noncanonical paths, and mounts in the provider-visible namespace. Its tmpfs has byte and inode ceilings before Git starts and sets `nosuid,nodev`. The runner still needs enough memory/swap. Failed release preserves recovery records and seed leases. Local release-backed Git acquisition uses bounded object reads and parent-controlled writes, so it does not need tmpfs.

Use the opt-in acquisition gates on the actual evaluation runner after installation. Helper installation alone does not establish runner capacity or filesystem behavior.
