#!/usr/bin/python3 -I
"""Root-owned Linux mount helper with pinned no-follow directory descriptors.
Install root:root 0755 at /usr/local/libexec/allagents-workspace-helper.
Grant only this exact executable through sudo, never unrestricted mount/umount.
"""
import ctypes, json, os, pathlib, re, stat, subprocess, sys
PACKAGE = '@allagents/promptfoo-integration'
UID = int(os.environ.get('SUDO_UID', os.getuid()))
GID = int(os.environ.get('SUDO_GID', os.getgid()))
FDS = []
PARENTS = {}
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def checked(raw):
    path = pathlib.Path(raw)
    if not path.is_absolute() or str(path) != raw or any(c in raw for c in ',:\n\x00') or '..' in path.parts:
        raise ValueError('noncanonical helper path')
    fd = os.open('/', FLAGS); FDS.append(fd)
    directories = [(pathlib.Path('/'), fd)]
    current = pathlib.Path('/')
    for component in path.parts[1:]:
        fd = os.open(component, FLAGS, dir_fd=fd); FDS.append(fd)
        current = current / component; directories.append((current, fd))
    root = None
    for directory, descriptor in reversed(directories):
        try: marker = os.open('.allagents-owner.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        except FileNotFoundError: continue
        try:
            info = os.fstat(marker)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != UID or info.st_mode & 0o022 or info.st_size > 4096:
                raise ValueError('unsafe ownership marker')
            data = json.loads(os.read(marker, 4096))
        finally: os.close(marker)
        if data.get('package') != PACKAGE or data.get('schemaVersion') != 1: raise ValueError('invalid ownership marker')
        if data.get('kind') == 'cache':
            owner = os.fstat(descriptor)
            if owner.st_uid != UID or owner.st_mode & 0o022: raise ValueError('unsafe package root')
            root = directory
            break
    if root is None or path == root or os.fstat(fd).st_uid != UID:
        raise ValueError('helper requires caller-owned contained package directory')
    PARENTS[fd] = (directories[-2][1], path.name)
    return path, root, fd

def fdpath(descriptor): return f'/proc/self/fd/{descriptor}'
def mounts():
    result = {}
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        pieces = line.split(' ')
        point = re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),pieces[4])
        separator = pieces.index('-')
        result[point] = ('ambiguous', 'ambiguous') if point in result else (pieces[separator + 1], pieces[separator + 2])
    return result

def run(args): subprocess.run(args, check=True, stdin=subprocess.DEVNULL, timeout=20, pass_fds=FDS)
def empty(fd): return not os.listdir(fd)
def unmount(target):
    parent, name = PARENTS[target]
    os.close(target); FDS.remove(target)
    libc = ctypes.CDLL('libc.so.6', use_errno=True)
    libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
    # The parent descriptor is outside the mounted fs; last-component links are rejected.
    if libc.umount2(f'{fdpath(parent)}/{name}'.encode(), 8) != 0:
        error = ctypes.get_errno(); raise OSError(error, os.strerror(error))

def main():
    if os.geteuid() != 0 or sys.platform != 'linux': raise ValueError('Linux privileged helper required')
    verb = sys.argv[1]
    if verb == 'acquire-tmpfs' and len(sys.argv) == 4:
        path, root, target = checked(sys.argv[2]); size = int(sys.argv[3])
        if path.relative_to(root).parts[0] != 'staging' or size <= 0 or size > 50*1024**3: raise ValueError('invalid bounded staging mount')
        if str(path) in mounts() or not empty(target): raise ValueError('occupied staging mount')
        run(['/usr/bin/mount','--no-canonicalize','-t','tmpfs','-o',f'size={size},nr_inodes={max(1024,size//1024)},mode=0700,uid={UID},gid={GID},nosuid,nodev','allagents-bounded',fdpath(target)])
    elif verb == 'release-tmpfs' and len(sys.argv) == 3:
        path, root, target = checked(sys.argv[2]); actual = mounts().get(str(path))
        if path.relative_to(root).parts[0] != 'staging': raise ValueError('invalid staging release')
        if actual is None: return
        if actual != ('tmpfs', 'allagents-bounded'): raise ValueError('refusing unknown mount')
        unmount(target)
    else: raise ValueError('unsupported helper operation')
try: main()
except Exception as error:
    print(str(error), file=sys.stderr); sys.exit(1)
finally:
    for descriptor in FDS: os.close(descriptor)
