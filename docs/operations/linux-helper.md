# Linux bounded staging and OverlayFS helper

Install the reviewed helper on a trusted Linux runner. It is a root-owned administrator capability. The provider invokes only this fixed path and one of four validated verbs. The helper checks package markers, pins every ancestor with `O_NOFOLLOW` directory descriptors, and mounts in the provider-visible namespace. It refuses unmarked roots, links, unknown mount types, and noncanonical paths. It never runs an authored command.

```sh
sudo install -D -o root -g root -m 0755 scripts/workspace-helper.py /usr/local/libexec/allagents-workspace-helper
```

Grant the runner's account only the fixed executable with `sudo visudo -f /etc/sudoers.d/allagents-promptfoo`. Replace `runner` with that account:

```sudoers
runner ALL=(root) NOPASSWD: /usr/local/libexec/allagents-workspace-helper
```

Do not grant `sudo mount`, `sudo umount`, an interpreter, or arbitrary executable overrides. Helper-owned mounts set `nosuid,nodev`. Acquisition tmpfs has a byte and inode ceiling before Git starts. The runner still needs enough memory/swap for that bounded tmpfs. Local release-backed Git acquisition uses bounded object reads and parent-controlled writes, so it does not need tmpfs.

OverlayFS uses `metacopy=on` to restore writable view modes without copying all immutable file data. Capability probes verify existing-file writes and sibling isolation. Kernel-created upper/work state is returned to the caller after a successful unmount. Detachment failure preserves recovery records and seed leases; it does not trigger a full-copy fallback or lower-layer deletion.

Use `bun test` plus the opt-in acquisition and scale gates after installation. Production rollout requires those checks on the actual evaluation runner. Helper installation alone is not proof that the runner supports the required filesystem behavior.
