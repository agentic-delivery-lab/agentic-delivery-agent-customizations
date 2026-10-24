# <!-- agentic-primitive: {"id":"workspace-lifecycle-guard","kind":"validator","enforcement":"deterministic","decisionIds":["ADR-0004","ADR-0007"],"domains":["agentic-delivery-governance"],"adrs":["ADR-0004","ADR-0007"]} -->
"""Local Linux coordination primitives; caller admission is separate from a lease."""
import hashlib
import os
import pathlib
import platform
import re
import stat
import subprocess
import sys
import time
try:
    import fcntl
except ImportError:
    fcntl = None

LOCAL_FILESYSTEMS = ('ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'tmpfs', 'overlay')


def require_linux_profile():
    if platform.system() != 'Linux' or sys.version_info < (3, 12) or fcntl is None:
        raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'Linux and Python 3.12+ are required')


class WorkspaceHold(Exception):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason

    def record(self):
        return {'schemaVersion': 1, 'status': 'held', 'reason': self.reason, 'message': str(self)}


def command(argv, *, input_data=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', LC_ALL='C')
    try:
        result = subprocess.run(argv, env=env, input=input_data, capture_output=True, timeout=15)
        if result.returncode or len(result.stdout) + len(result.stderr) > 8 * 1024 * 1024:
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', f'Bounded inspection failed: {argv[0]}')
        return result.stdout
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WorkspaceHold('INSPECTION_UNAVAILABLE', f'Inspection unavailable: {argv[0]}') from error


def git(repository, *args, input_data=None):
    return command(['git', '--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false',
                    '-C', str(repository), *args], input_data=input_data)


def filesystem_kind(directory):
    return command(['findmnt', '--noheadings', '--raw', '--output', 'FSTYPE', '--target', str(directory)]).decode().strip()


def private_account_path(directory):
    """This initial profile excludes paths accessible to other unprivileged accounts."""
    for ancestor in (directory, *directory.parents):
        metadata = ancestor.stat()
        if metadata.st_uid == os.getuid() and not metadata.st_mode & 0o077:
            return True
    return False


def read_inventory(repository):
    """Read Git's explicit machine formats; never repair, fetch, prune or clean."""
    common = os.fsdecode(git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir').removesuffix(b'\n'))
    worktrees = []
    for block in git(repository, 'worktree', 'list', '--porcelain', '-z').split(b'\0\0'):
        if not block:
            continue
        attributes = {}
        for line in block.split(b'\0'):
            key, separator, value = line.partition(b' ')
            attributes[os.fsdecode(key)] = os.fsdecode(value) if separator else True
        location = pathlib.Path(attributes['worktree'])
        row = {'path': str(location), 'head': attributes.get('HEAD'), 'branch': attributes.get('branch'),
               'locked': attributes.get('locked'), 'prunable': attributes.get('prunable'),
               'available': location.is_dir(), 'inspection': 'unavailable', 'changes': None,
               'ignored': None, 'operations': None, 'unsafeIndex': None, 'problem': None}
        if row['available']:
            try:
                split_paths = lambda data: [os.fsdecode(item) for item in data.split(b'\0') if item]
                row['changes'] = split_paths(git(location, 'diff-index', '--cached', '--raw', '-z', '--no-ext-diff', 'HEAD'))
                row['changes'] += ['?? ' + name for name in split_paths(git(location, 'ls-files', '--others', '--exclude-standard', '-z'))]
                row['ignored'] = split_paths(git(location, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'))
                row['unsafeIndex'] = [{'path': os.fsdecode(item[2:]), 'reason': 'hidden-index-flags'}
                                      for item in git(location, 'ls-files', '-v', '-z').split(b'\0')
                                      if item and (item[:1].islower() or item[:1] == b'S')]
                for item in git(location, 'ls-files', '--stage', '-z').split(b'\0'):
                    if not item: continue
                    header, filename = item.split(b'\t', 1)
                    mode, _object, stage = header.split()
                    if mode == b'160000' or stage != b'0':
                        row['unsafeIndex'].append({'path': os.fsdecode(filename), 'reason': 'submodule-or-unmerged-index'})
                if not row['unsafeIndex']:
                    try:
                        verify_tracked_bytes(location)
                    except WorkspaceHold as error:
                        if error.reason != 'DIRTY_WORKSPACE': raise
                        row['changes'].append(str(error))
                directory = pathlib.Path(os.fsdecode(git(location, 'rev-parse', '--absolute-git-dir').removesuffix(b'\n')))
                row['operations'] = [name for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'index.lock')
                                     if os.path.lexists(directory / name)]
                row['inspection'] = 'inspected'
            except WorkspaceHold as error:
                row['problem'] = error.record()  # Unknown never becomes a clean observation.
        worktrees.append(row)
    if not worktrees:
        raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'No registered primary worktree was found')
    refs = []
    for line in git(repository, 'for-each-ref', '--format=%(refname)%00%(objectname)%00').splitlines():
        name, tip, end = line.split(b'\0')
        if end:
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Invalid ref record')
        refs.append({'name': os.fsdecode(name), 'tip': tip.decode('ascii')})
    stashes = git(repository, 'log', '-g', '--format=%H', 'refs/stash').decode('ascii').splitlines() if any(row['name'] == 'refs/stash' for row in refs) else []
    return {'schemaVersion': 1, 'status': 'inspected', 'commonGitDirectory': common,
            'primary': worktrees[0]['path'], 'worktrees': worktrees, 'refs': refs, 'stashes': stashes}


def _process_identity(process):
    fields = os.fsdecode((process / 'stat').read_bytes()).rsplit(')', 1)[1].split()
    return {'pid': int(process.name), 'startTicks': int(fields[19]), 'uid': process.stat().st_uid,
            'comm': os.fsdecode((process / 'comm').read_bytes()).removesuffix('\n'), 'cgroup': os.fsdecode((process / 'cgroup').read_bytes())}


def _reference_hits(target, roots, *, escaped=False):
    candidates = {target, target.removesuffix(' (deleted)')}
    if escaped:
        candidates.update(value.replace('\\012', '\n') for value in tuple(candidates))
    return any(value == root or value.startswith(root + '/') for value in candidates for root in roots)


def verify_tracked_bytes(repository):
    """Compare raw bytes without relying on stat caches, filters or index refreshes."""
    if git(repository, 'diff-index', '--cached', '--raw', '-z', '--no-ext-diff', 'HEAD'):
        raise WorkspaceHold('DIRTY_WORKSPACE', 'Staged work must be preserved')
    staged = git(repository, 'ls-files', '--stage', '-z')
    entries = []
    for item in staged.split(b'\0'):
        if not item: continue
        header, filename = item.split(b'\t', 1)
        mode, oid, stage = header.split()
        if mode not in (b'100644', b'100755', b'120000') or stage != b'0':
            raise WorkspaceHold('UNSAFE_INDEX_STATE', 'Tracked index entries are outside the admitted profile')
        entries.append((filename, mode, oid))
    requests = b''.join(oid + b'\n' for oid in sorted({entry[2] for entry in entries}))
    details = git(repository, 'cat-file', '--batch-check', input_data=requests).split(b'\n')
    expected, total = {}, 0
    for line in details:
        if not line: continue
        fields = line.split()
        if len(fields) != 3:
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Immutable tracked blob is missing or unavailable')
        oid, kind, size = fields
        try:
            length = int(size)
        except ValueError as error:
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Invalid immutable blob size') from error
        if kind != b'blob' or length < 0:
            raise WorkspaceHold('UNSAFE_INDEX_STATE', 'Expected a regular Git blob')
        total += length + len(line) + 2
        if total > 8 * 1024 * 1024:
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Tracked snapshot exceeds the admitted byte bound')
        expected[oid] = {'size': length}
    payload = git(repository, 'cat-file', '--batch', input_data=requests)
    offset = 0
    for oid in sorted(expected):
        end = payload.find(b'\n', offset)
        header = oid + b' blob ' + str(expected[oid]['size']).encode()
        size = expected[oid]['size']
        if end < 0 or payload[offset:end] != header or payload[end + 1 + size:end + 2 + size] != b'\n':
            raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Invalid immutable blob snapshot')
        expected[oid]['sha256'] = hashlib.sha256(payload[end + 1:end + 1 + size]).digest()
        offset = end + size + 2
    if offset != len(payload):
        raise WorkspaceHold('INSPECTION_UNAVAILABLE', 'Unexpected immutable blob snapshot bytes')
    for filename, mode, oid in entries:
        parts = filename.split(b'/')
        if any(part in (b'', b'.', b'..') for part in parts):
            raise WorkspaceHold('UNSAFE_TRACKED_INPUT', 'Tracked path is outside the declared worktree')
        directory = descriptor = None
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory = os.open(repository, flags)
            for part in parts[:-1]:
                following = os.open(part, flags, dir_fd=directory)
                os.close(directory); directory = following
            if mode == b'120000':
                data = os.readlink(parts[-1], dir_fd=directory)
                digest = hashlib.sha256(data).digest()
            else:
                descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                before = os.fstat(descriptor)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise WorkspaceHold('UNSAFE_TRACKED_INPUT', 'Only regular single-link tracked files are admitted')
                if before.st_size != expected[oid]['size'] or bool(before.st_mode & 0o111) != (mode == b'100755'):
                    raise WorkspaceHold('DIRTY_WORKSPACE', 'Tracked size or executable mode differs from the index')
                hasher, count = hashlib.sha256(), 0
                while chunk := os.read(descriptor, min(65536, expected[oid]['size'] + 1 - count)):
                    count += len(chunk); hasher.update(chunk)
                    if count > expected[oid]['size']: break
                after = os.fstat(descriptor)
                current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                fields = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mode, item.st_mtime_ns, item.st_ctime_ns)
                if fields(before) != fields(after) or fields(after) != fields(current):
                    raise WorkspaceHold('DIRTY_WORKSPACE', 'Tracked file changed during verification')
                digest = hasher.digest()
            if digest != expected[oid]['sha256']:
                raise WorkspaceHold('DIRTY_WORKSPACE', 'Tracked bytes differ from the immutable indexed blob')
        except OSError as error:
            raise WorkspaceHold('UNSAFE_TRACKED_INPUT', 'Tracked path cannot be read without following redirects') from error
        finally:
            if descriptor is not None: os.close(descriptor)
            if directory is not None: os.close(directory)
    if staged != git(repository, 'ls-files', '--stage', '-z') or git(repository, 'diff-index', '--cached', '--raw', '-z', '--no-ext-diff', 'HEAD'):
        raise WorkspaceHold('DIRTY_WORKSPACE', 'Tracked index changed during verification')


def _task_references(task, roots, primary, inspect_mappings):
    references = []
    for kind, link in [('cwd', task / 'cwd'), ('exe', task / 'exe')] + [('fd', item) for item in (task / 'fd').iterdir()]:
        try:
            target = os.readlink(link)
        except FileNotFoundError:
            continue
        if kind == 'cwd' and primary is not None and (target == primary or target.startswith(primary + '/')):
            continue  # The invoking owner's primary is retained, including its threads.
        if _reference_hits(target, roots):
            references.append({'kind': kind, 'path': target})
    if not inspect_mappings:
        return references, True
    with (task / 'maps').open('rb') as mappings:
        data = mappings.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise WorkspaceHold('UNCERTAIN_CONSUMERS', 'Task mappings exceed the admitted observation bound')
    for line in data.split(b'\n'):
        columns = line.split(None, 5)
        if len(columns) == 6:
            target = os.fsdecode(columns[5])
            if _reference_hits(target, roots, escaped=True):
                references.append({'kind': 'mapping', 'path': target})
    return references, bool(data)


def consumer_probe(paths, *, service_monitors=(), owner_primary=None):
    """Observe same-account consumers. Exceptions require exact, caller-admitted host identities."""
    require_linux_profile()
    roots = [str(pathlib.Path(path).resolve()) for path in paths]
    if any(not private_account_path(pathlib.Path(root)) for root in roots):
        raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'Consumer coverage requires account-private paths')
    lineage = {}
    parent = os.getpid()
    while owner_primary is not None and parent and parent not in lineage:
        fields = pathlib.Path(f'/proc/{parent}/stat').read_text().rsplit(')', 1)[1].split()
        lineage[parent] = int(fields[19]); parent = int(fields[1])
    primary = str(pathlib.Path(owner_primary).resolve()) if owner_primary is not None else None
    fields = {'pid', 'startTicks', 'uid', 'comm', 'cgroup', 'reason'}
    for monitor in service_monitors:
        if (set(monitor) != fields or type(monitor['pid']) is not int or monitor['pid'] < 1
                or type(monitor['startTicks']) is not int or monitor['uid'] != os.getuid()
                or monitor['comm'] not in ('systemd', '(sd-pam)', 'sshd-session')
                or not isinstance(monitor['cgroup'], str) or not monitor['cgroup']
                or not isinstance(monitor['reason'], str) or not monitor['reason'].strip()):
            raise WorkspaceHold('INVALID_PROCESS_PROFILE', 'Host service exceptions require exact admitted identities and reasons')
    consumers, unknown, verified = [], [], []
    deadline = time.monotonic() + 15
    for process in pathlib.Path('/proc').iterdir():
        if time.monotonic() >= deadline:
            raise WorkspaceHold('UNCERTAIN_CONSUMERS', 'Process inventory exceeded the supported profile bound')
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        identity = None
        try:
            if process.stat().st_uid != os.getuid():
                continue  # Admitted paths must have an account-private ancestor.
            identity = _process_identity(process)
            tasks = {task.name: task for task in (process / 'task').iterdir() if task.name.isdigit()}
            mappings_observed = False
            for task in tasks.values():
                if time.monotonic() >= deadline:
                    raise WorkspaceHold('UNCERTAIN_CONSUMERS', 'Task inventory exceeded the supported profile bound')
                try:
                    task_identity = _process_identity(task)
                    retained_primary = primary if lineage.get(identity['pid']) == identity['startTicks'] else None
                    references, mappings_observed = _task_references(task, roots, retained_primary, not mappings_observed)
                    # Linux thread groups share CLONE_VM. Read one available map;
                    # an exited leader's empty map must not hide a live worker.
                    for reference in references:
                        consumers.append({'pid': identity['pid'], 'startTicks': identity['startTicks'],
                                          'tid': task_identity['pid'], **reference})
                    if _process_identity(task) != task_identity:
                        unknown.append(identity['pid'])
                except (FileNotFoundError, ProcessLookupError):
                    unknown.append(identity['pid'])
                    continue
            if not tasks or set(tasks) != {task.name for task in (process / 'task').iterdir() if task.name.isdigit()}:
                unknown.append(identity['pid'])
            if _process_identity(process) != identity:
                unknown.append(int(process.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            try:
                stable = identity is not None and identity == _process_identity(process)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                stable = False
            if stable and any(all(monitor[key] == value for key, value in identity.items()) for monitor in service_monitors):
                verified.append(identity['pid'])
            else:
                unknown.append(int(process.name))
    return {'schemaVersion': 1, 'clear': not consumers and not unknown, 'consumers': consumers,
            'unknownProcesses': sorted(set(unknown)), 'verifiedServiceMonitors': sorted(verified)}


def local_cleanup_admission(lease, *, branch, expected_tip, expected_default_tip, worktree=None, service_monitors=()):
    """Check local disposal under a live exclusive lease; this is not hosting authorization."""
    lease.assert_current()
    if lease._held_mode != 'cleanup':
        raise WorkspaceHold('EXCLUSIVE_LEASE_REQUIRED', 'Cleanup admission requires an exclusive lease')
    if (not isinstance(branch, str) or not branch or any(not isinstance(value, str) or re.fullmatch('[0-9a-f]{40}', value) is None
                                                       for value in (expected_tip, expected_default_tip))):
        raise WorkspaceHold('INVALID_CLEANUP_REQUEST', 'Exact branch and immutable observed tips are required')
    if branch == 'main' or branch.startswith(('release/', 'support/', 'refs/')):
        raise WorkspaceHold('PROTECTED_BRANCH', 'Default, release and support branches are preserved')
    git(lease.repository, 'check-ref-format', '--branch', branch)
    inventory = read_inventory(lease.repository)
    if pathlib.Path(inventory['commonGitDirectory']).resolve() != lease.common:
        raise WorkspaceHold('WORKSPACE_INPUT_CHANGED', 'Repository common directory changed')
    refs = {row['name']: row['tip'] for row in inventory['refs']}
    if refs.get(f'refs/heads/{branch}') != expected_tip:
        raise WorkspaceHold('CHANGED_TIP', 'Task branch tip differs from its admitted observation')
    if 'refs/remotes/origin/main' not in refs:
        raise WorkspaceHold('REMOTE_NOT_VERIFIED', 'A fetched remote default and fresh caller observation are required')
    if refs['refs/remotes/origin/main'] != expected_default_tip:
        raise WorkspaceHold('CHANGED_REMOTE_DEFAULT', 'Fetched default differs from the fresh caller observation')
    if git(lease.repository, 'symbolic-ref', 'refs/remotes/origin/HEAD').removesuffix(b'\n') != b'refs/remotes/origin/main':
        raise WorkspaceHold('REMOTE_NOT_VERIFIED', 'Remote default identity is outside the admitted main profile')
    if git(lease.repository, 'merge-base', expected_tip, expected_default_tip).removesuffix(b'\n').decode() != expected_tip:
        raise WorkspaceHold('UNMERGED_WORKSPACE', 'Exact task tip is not integrated into the observed default')
    if any(row['inspection'] != 'inspected' for row in inventory['worktrees']):
        raise WorkspaceHold('UNKNOWN_WORKTREE', 'Every registered worktree must be inspectable before local disposal')
    primary = pathlib.Path(inventory['primary']).resolve()
    attached = [row for row in inventory['worktrees'] if row['branch'] == f'refs/heads/{branch}']
    target = None
    if worktree is not None:
        target = pathlib.Path(worktree).resolve()
        if target == primary:
            raise WorkspaceHold('PRIMARY_WORKTREE_PRESERVED', 'The primary checkout is never a removal target')
        expected_path = primary.with_name(primary.name + '.worktrees') / branch.replace('/', '-')
        if target != expected_path:
            raise WorkspaceHold('UNMANAGED_WORKTREE', 'Task worktree is outside the canonical sibling layout')
        if filesystem_kind(target) not in LOCAL_FILESYSTEMS:
            raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'Task data must also use an admitted local filesystem')
        if len(attached) != 1 or pathlib.Path(attached[0]['path']).resolve() != target:
            raise WorkspaceHold('UNKNOWN_WORKTREE', 'Task branch and registered worktree do not match')
        row = attached[0]
        if row['head'] != expected_tip:
            raise WorkspaceHold('CHANGED_TIP', 'Registered worktree HEAD differs from the admitted task tip')
        if row['locked'] != f'agentic-workspace-v1 owner={lease._held_owner}':
            raise WorkspaceHold('UNKNOWN_WORKTREE_OWNER', 'Only the admitted owner may release its own worktree lock')
        if row['unsafeIndex']:
            raise WorkspaceHold('UNSAFE_INDEX_STATE', 'Hidden index flags, submodules or unresolved stages require explicit recovery')
        if row['changes'] or row['operations']:
            raise WorkspaceHold('DIRTY_WORKSPACE', 'Dirty files or an in-progress Git operation must be preserved')
        if row['ignored']:
            raise WorkspaceHold('UNOWNED_IGNORED_ARTIFACTS', 'Ignored artifacts require verified producer teardown before removal')
        verify_tracked_bytes(target)
        if pathlib.Path.cwd() == target or target in pathlib.Path.cwd().parents:
            raise WorkspaceHold('ACTIVE_CONSUMERS', 'The cleanup process must leave the task worktree first')
    elif attached:
        raise WorkspaceHold('WORKTREE_ATTACHED', 'A task branch checked out in any worktree cannot be deleted')
    probe = consumer_probe([lease.common, *[row['path'] for row in inventory['worktrees']]],
                           service_monitors=service_monitors, owner_primary=primary)
    if not probe['clear']:
        raise WorkspaceHold('ACTIVE_CONSUMERS' if probe['consumers'] else 'UNCERTAIN_CONSUMERS', 'Active or uninspectable consumers block disposal')
    lease.assert_current()
    return {'schemaVersion': 1, 'status': 'locally-admissible', 'branch': branch, 'tip': expected_tip,
            'observedDefaultTip': expected_default_tip, 'worktree': str(target) if target else None,
            'owner': lease._held_owner, 'consumerEvidence': probe, 'hostingAuthorized': False}


class WorkspaceLease:
    def __init__(self, repository, mode, owner):
        self.repository, self.mode, self.owner = pathlib.Path(repository), mode, owner
        self.fd = None
        self._held_mode = self._held_owner = None

    def __enter__(self):
        if self.fd is not None:
            raise WorkspaceHold('LEASE_ALREADY_HELD', 'A live lease cannot be re-entered or converted')
        require_linux_profile()
        if self.mode not in ('use', 'cleanup') or not isinstance(self.owner, str) or not self.owner.strip() or len(self.owner) > 128:
            raise WorkspaceHold('INVALID_LEASE_REQUEST', 'Explicit lease mode and owner are required')
        self.repository = self.repository.resolve(strict=True)
        if not private_account_path(self.repository):
            raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'This profile requires a private account workspace path')
        self.common = pathlib.Path(os.fsdecode(git(self.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir').removesuffix(b'\n'))).resolve(strict=True)
        common_stat = self.common.stat()
        if not private_account_path(self.common):
            raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'Common Git storage must use a private account path')
        if common_stat.st_uid != os.getuid() or common_stat.st_mode & 0o022:
            raise WorkspaceHold('UNKNOWN_LOCK_FILE', 'Common Git directory must have known private write ownership')
        self.filesystem = filesystem_kind(self.common)
        if self.filesystem not in LOCAL_FILESYSTEMS or filesystem_kind(self.repository) not in LOCAL_FILESYSTEMS:
            raise WorkspaceHold('UNSUPPORTED_WORKSPACE_PROFILE', 'Filesystem is outside the local Linux lock profile')
        self.path = self.common / 'codex-workspace-lifecycle.lock'
        try:
            self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            metadata = os.fstat(self.fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_nlink != 1 or metadata.st_mode & 0o022:
                raise WorkspaceHold('UNKNOWN_LOCK_FILE', 'Lock file ownership or type is not admitted')
            try:
                fcntl.flock(self.fd, (fcntl.LOCK_SH if self.mode == 'use' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise WorkspaceHold('WORKSPACE_IN_USE', 'An incompatible workspace lease is active') from error
            self._held_mode, self._held_owner = self.mode, self.owner
            self.assert_current()
            return self
        except OSError as error:
            self.__exit__(None, None, None)
            raise WorkspaceHold('UNKNOWN_LOCK_FILE', 'Lock file cannot be admitted without following links') from error
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def assert_current(self):
        if self.fd is None:
            raise WorkspaceHold('LEASE_NOT_HELD', 'A live lease is required')
        metadata = os.fstat(self.fd)
        try:
            current = self.path.lstat()
        except FileNotFoundError as error:
            raise WorkspaceHold('WORKSPACE_INPUT_CHANGED', 'Lease file disappeared') from error
        if (metadata.st_dev, metadata.st_ino) != (current.st_dev, current.st_ino) or not stat.S_ISREG(current.st_mode) or current.st_mode & 0o022:
            raise WorkspaceHold('WORKSPACE_INPUT_CHANGED', 'Lease file identity or permissions changed')

    def child_fds(self):
        self.assert_current()
        return (self.fd,)

    def evidence(self):
        self.assert_current()
        return {'schemaVersion': 1, 'status': 'leased', 'profile': 'linux-local-flock-v1', 'mode': self._held_mode,
                'owner': self._held_owner, 'commonGitDirectory': str(self.common), 'filesystem': self.filesystem}

    def __exit__(self, *_args):
        if self.fd is not None:
            os.close(self.fd)  # Never LOCK_UN: an inherited child may still own this open description.
            self.fd = None
            self._held_mode = self._held_owner = None
