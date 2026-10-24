import importlib.util
import ctypes
import json
import os
import pathlib
import subprocess
import select
import shlex
import signal
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'validators/workspace-lifecycle/workspace_guard.py'
spec = importlib.util.spec_from_file_location('workspace_guard', SOURCE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

LOAD = '''import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('workspace_guard',sys.argv[1])
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
try:
 with guard.WorkspaceLease(sys.argv[2],sys.argv[3],'fixture-child') as lease:
  print(json.dumps(lease.evidence()),flush=True)
except guard.WorkspaceHold as error:
 print(json.dumps(error.record()),flush=True);sys.exit(3)
'''


class WorkspaceGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='workspace-guard-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name) / 'repo'
        self.root.mkdir()
        subprocess.run(['git', 'init', '-q', '--initial-branch=main', str(self.root)], check=True)
        self.lock = self.root / '.git/codex-workspace-lifecycle.lock'

    def child(self, mode):
        result = subprocess.run([sys.executable, '-c', LOAD, str(SOURCE), str(self.root), mode],
                                capture_output=True, text=True, timeout=15)
        return result.returncode, json.loads(result.stdout)

    def git(self, directory, *args):
        return subprocess.check_output(['git', '-C', str(directory), '-c', 'user.name=Synthetic fixture',
                                        '-c', 'user.email=fixture@example.invalid', *args]).removesuffix(b'\n')

    def task(self, label='task'):
        primary = pathlib.Path(self.temporary.name) / label / 'repo'
        primary.mkdir(parents=True)
        self.git(primary, 'init', '-q', '--initial-branch=main')
        (primary / 'README.md').write_text('synthetic base\n')
        self.git(primary, 'add', '.'); self.git(primary, 'commit', '-qm', 'Synthetic base')
        branch = 'feat/issue-2-synthetic'
        worktree = primary.parent / 'repo.worktrees/feat-issue-2-synthetic'
        self.git(primary, 'worktree', 'add', '-q', '-b', branch, str(worktree))
        return primary, worktree, branch

    def merged_task(self, label, merged=True, prepare=None):
        primary, worktree, branch = self.task(label)
        (worktree / 'README.md').write_text('synthetic task\n')
        if prepare is not None: prepare(primary, worktree)
        self.git(worktree, 'add', '.'); self.git(worktree, 'commit', '-qm', 'Synthetic task')
        tip = self.git(worktree, 'rev-parse', 'HEAD').decode()
        if merged: self.git(primary, 'merge', '--no-ff', '-qm', 'Synthetic integration', branch)
        default = self.git(primary, 'rev-parse', 'main').decode()
        self.git(primary, 'update-ref', 'refs/remotes/origin/main', default)
        self.git(primary, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
        self.git(primary, 'worktree', 'lock', '--reason', 'agentic-workspace-v1 owner=fixture-task', str(worktree))
        return primary, worktree, branch, tip, default

    def service_monitors(self):
        # Fixture host profile, explicitly restricted to observed service identities.
        records = []
        for process in pathlib.Path('/proc').iterdir():
            if not process.name.isdigit(): continue
            try:
                comm = (process / 'comm').read_text().removesuffix('\n')
                if process.stat().st_uid == os.getuid() and comm in ('systemd', '(sd-pam)', 'sshd-session'):
                    records.append({'pid': int(process.name), 'uid': os.getuid(), 'comm': comm,
                                    'startTicks': int((process / 'stat').read_text().rsplit(')', 1)[1].split()[19]),
                                    'cgroup': (process / 'cgroup').read_text(), 'reason': 'Fixture host service identity'})
            except FileNotFoundError: pass
        return records

    def test_local_cleanup_admission_enforces_actual_git_state(self):
        cases = {'clean': None, 'unmerged': 'UNMERGED_WORKSPACE', 'dirty': 'DIRTY_WORKSPACE',
                 'staged': 'DIRTY_WORKSPACE', 'untracked': 'DIRTY_WORKSPACE', 'ignored': 'UNOWNED_IGNORED_ARTIFACTS',
                 'unknown-owner': 'UNKNOWN_WORKTREE_OWNER', 'changed-tip': 'CHANGED_TIP',
                 'changed-default': 'CHANGED_REMOTE_DEFAULT', 'active': 'ACTIVE_CONSUMERS',
                 'missing-remote': 'REMOTE_NOT_VERIFIED', 'primary': 'PRIMARY_WORKTREE_PRESERVED'}
        for name, expected in cases.items():
            with self.subTest(name=name):
                primary, worktree, branch, tip, default = self.merged_task(name, merged=name != 'unmerged')
                child = None
                if name in ('dirty', 'staged'):
                    (worktree / 'README.md').write_text('preserve edits\n')
                    if name == 'staged': self.git(worktree, 'add', 'README.md')
                if name == 'untracked': (worktree / 'unknown.txt').write_text('preserve')
                if name == 'ignored':
                    info = primary / '.git/info/exclude'; info.write_text('precious.log\n')
                    (worktree / 'precious.log').write_text('preserve ignored work')
                if name == 'unknown-owner':
                    self.git(primary, 'worktree', 'unlock', str(worktree))
                    self.git(primary, 'worktree', 'lock', '--reason', 'foreign owner; preserve', str(worktree))
                if name == 'changed-tip':
                    (worktree / 'new.txt').write_text('new unique work')
                    self.git(worktree, 'add', '.'); self.git(worktree, 'commit', '-qm', 'Synthetic changed tip')
                if name == 'changed-default': self.git(primary, 'update-ref', 'refs/remotes/origin/main', f'{default}^')
                if name == 'missing-remote': self.git(primary, 'update-ref', '-d', 'refs/remotes/origin/main')
                if name == 'active':
                    child = subprocess.Popen([sys.executable, '-c', 'import sys;print("ready",flush=True);sys.stdin.buffer.read(1)'],
                                             cwd=worktree, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                    self.assertEqual(child.stdout.readline(), b'ready\n')
                try:
                    with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
                        request = dict(branch=branch, expected_tip=tip, expected_default_tip=default,
                                       worktree=primary if name == 'primary' else worktree, service_monitors=self.service_monitors())
                        if expected:
                            with self.assertRaises(guard.WorkspaceHold) as caught: guard.local_cleanup_admission(lease, **request)
                            self.assertEqual(caught.exception.reason, expected)
                        else:
                            self.assertEqual(guard.local_cleanup_admission(lease, **request)['status'], 'locally-admissible')
                    self.assertTrue(worktree.exists())
                    self.assertTrue(self.git(primary, 'show-ref', '--verify', f'refs/heads/{branch}'))
                finally:
                    if child is not None: child.communicate(b'x', timeout=5)

    def test_inventory_preserves_nul_delimited_paths_and_lock_reasons_without_mutation(self):
        primary, worktree, branch = self.task('path with space')
        reason = 'fixture-owner\nretained for synthetic testing'
        self.git(primary, 'worktree', 'lock', '--reason', reason, str(worktree))
        (worktree / 'untracked\nfile').write_text('preserve')
        before_index = (primary / '.git/index').read_bytes()
        inventory = guard.read_inventory(primary)
        self.assertEqual(inventory['primary'], str(primary))
        self.assertEqual(inventory['worktrees'][1]['branch'], f'refs/heads/{branch}')
        self.assertEqual(inventory['worktrees'][1]['locked'], reason)
        self.assertIn('?? untracked\nfile', inventory['worktrees'][1]['changes'])
        self.assertEqual((primary / '.git/index').read_bytes(), before_index)
        self.assertFalse((primary / '.git/codex-workspace-lifecycle.lock').exists())

    def test_inventory_marks_missing_registered_worktrees_unknown_and_preserves_them(self):
        primary, worktree, _branch = self.task()
        moved = worktree.with_name('manually-moved')
        worktree.rename(moved)
        inventory = guard.read_inventory(primary)
        self.assertFalse(inventory['worktrees'][1]['available'])
        self.assertEqual(inventory['worktrees'][1]['inspection'], 'unavailable')
        self.assertTrue(moved.exists())

    def test_consumer_probe_observes_a_real_reader_without_a_protocol_lease(self):
        primary, worktree, _branch = self.task()
        child = subprocess.Popen([sys.executable, '-c', 'import sys;print("ready",flush=True);sys.stdin.buffer.read(1)'],
                                 cwd=worktree, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            result = guard.consumer_probe([primary, worktree])
            self.assertIn(child.pid, [item['pid'] for item in result['consumers']])
            self.assertFalse(result['clear'])
            self.assertIsNone(child.poll())
            self.assertEqual((worktree / 'README.md').read_text(), 'synthetic base\n')
        finally:
            child.communicate(b'x', timeout=5)

    def test_unreadable_consumers_remain_unknown_despite_a_stale_service_identity(self):
        child = subprocess.Popen([sys.executable, '-c', 'import ctypes,sys;assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print("ready",flush=True);sys.stdin.buffer.read(1)'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            identity = {'pid': child.pid, 'startTicks': int(pathlib.Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]),
                        'uid': os.getuid(), 'comm': 'systemd', 'cgroup': pathlib.Path(f'/proc/{child.pid}/cgroup').read_text(),
                        'reason': 'Synthetic stale monitor identity'}
            result = guard.consumer_probe([self.root], service_monitors=[identity])
            self.assertIn(child.pid, result['unknownProcesses'])
            self.assertFalse(result['clear'])
        finally:
            child.communicate(b'x', timeout=5)

    def test_consumer_probe_preserves_non_utf8_process_names(self):
        program = r'''import ctypes,sys
name=ctypes.create_string_buffer(b'fixture-\xff')
assert ctypes.CDLL(None).prctl(15,name,0,0,0)==0
print('ready',flush=True);sys.stdin.buffer.read(1)
'''
        child = subprocess.Popen([sys.executable, '-c', program], cwd=self.root,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            result = guard.consumer_probe([self.root])
            self.assertIn(child.pid, [item['pid'] for item in result['consumers']])
        finally:
            child.communicate(b'x', timeout=5)

    def test_index_hidden_tracked_changes_are_not_admitted(self):
        for option in ['--assume-unchanged', '--skip-worktree']:
            with self.subTest(option=option):
                primary, worktree, branch, tip, default = self.merged_task(option[2:])
                self.git(worktree, 'update-index', option, 'README.md')
                (worktree / 'README.md').write_text('preserve hidden edit\n')
                self.assertEqual(self.git(worktree, 'status', '--porcelain=v1', '-z'), b'')
                index_path = pathlib.Path(os.fsdecode(self.git(worktree, 'rev-parse', '--git-path', 'index')))
                if not index_path.is_absolute(): index_path = worktree / index_path
                before = index_path.read_bytes()
                with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
                    with self.assertRaises(guard.WorkspaceHold) as caught:
                        guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                                      worktree=worktree, service_monitors=self.service_monitors())
                    self.assertEqual(caught.exception.reason, 'UNSAFE_INDEX_STATE')
                self.assertEqual(index_path.read_bytes(), before)
                self.assertEqual((worktree / 'README.md').read_text(), 'preserve hidden edit\n')

    def test_stat_cache_cannot_hide_changed_tracked_bytes(self):
        primary, worktree, branch, tip, default = self.merged_task('stat-cache')
        filename = worktree / 'README.md'
        older = time.time_ns() - 60_000_000_000
        os.utime(filename, ns=(older, older))
        self.git(worktree, 'update-index', '--refresh')
        self.git(primary, 'config', 'core.trustctime', 'false')
        self.git(primary, 'config', 'core.checkStat', 'minimal')
        before = filename.stat()
        filename.write_text('SYNTHETIC TASK\n')
        os.utime(filename, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.git(worktree, 'status', '--porcelain=v1', '-z'), b'')
        with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
            with self.assertRaises(guard.WorkspaceHold) as caught:
                guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                              worktree=worktree, service_monitors=self.service_monitors())
            self.assertEqual(caught.exception.reason, 'DIRTY_WORKSPACE')
        self.assertEqual(filename.read_text(), 'SYNTHETIC TASK\n')

    def test_clean_filter_and_filemode_config_cannot_hide_tracked_changes(self):
        for name in ['filter', 'mode']:
            with self.subTest(name=name):
                constant = pathlib.Path(self.temporary.name) / 'filter-template'
                constant.write_text('synthetic task\n')
                def prepare(primary, worktree):
                    if name == 'filter':
                        (worktree / '.gitattributes').write_text('README.md filter=fixture\n')
                        self.git(primary, 'config', 'filter.fixture.clean', 'cat -- ' + shlex.quote(str(constant)))
                    else: self.git(primary, 'config', 'core.filemode', 'false')
                primary, worktree, branch, tip, default = self.merged_task('hidden-' + name, prepare=prepare)
                filename = worktree / 'README.md'
                if name == 'filter': filename.write_text('SYNTHETIC TASK\n')
                else: filename.chmod(0o755)
                self.assertEqual(self.git(worktree, 'status', '--porcelain=v1', '-z'), b'')
                with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
                    with self.assertRaises(guard.WorkspaceHold) as caught:
                        guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                                      worktree=worktree, service_monitors=self.service_monitors())
                    self.assertEqual(caught.exception.reason, 'DIRTY_WORKSPACE')
                self.assertTrue(filename.exists())

    def test_missing_blob_preserves_recoverable_worktree_bytes(self):
        primary, worktree, branch, tip, default = self.merged_task('missing-object')
        oid = self.git(worktree, 'rev-parse', 'HEAD:README.md').decode()
        loose_object = primary / '.git/objects' / oid[:2] / oid[2:]
        self.assertTrue(loose_object.is_file())
        loose_object.unlink()  # Synthetic damaged object database, not a source checkout.
        with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
            with self.assertRaises(guard.WorkspaceHold):
                guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                              worktree=worktree, service_monitors=self.service_monitors())
        self.assertEqual((worktree / 'README.md').read_text(), 'synthetic task\n')

    def test_ignored_submodule_dirt_is_not_admitted(self):
        module = pathlib.Path(self.temporary.name) / 'synthetic-module'
        module.mkdir(); self.git(module, 'init', '-q', '--initial-branch=main')
        (module / 'value.txt').write_text('synthetic module\n')
        self.git(module, 'add', '.'); self.git(module, 'commit', '-qm', 'Synthetic module')
        def add_module(primary, worktree):
            self.git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', 'fixture', str(module), 'dependency')
            self.git(primary, 'config', 'submodule.fixture.ignore', 'all')
        primary, worktree, branch, tip, default = self.merged_task('submodule', prepare=add_module)
        (worktree / 'dependency/value.txt').write_text('preserve hidden submodule edit\n')
        self.assertEqual(self.git(worktree, 'status', '--porcelain=v1', '-z'), b'')
        with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
            with self.assertRaises(guard.WorkspaceHold) as caught:
                guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                              worktree=worktree, service_monitors=self.service_monitors())
            self.assertEqual(caught.exception.reason, 'UNSAFE_INDEX_STATE')
        self.assertEqual((worktree / 'dependency/value.txt').read_text(), 'preserve hidden submodule edit\n')

    def test_executable_reference_outside_cwd_and_fds_is_observed(self):
        binary = self.root / 'synthetic-sleeper'
        shutil.copy2(shutil.which('sleep'), binary)
        child = subprocess.Popen([str(binary), '60'], cwd=self.temporary.name,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(os.readlink(f'/proc/{child.pid}/exe'), str(binary))
            result = guard.consumer_probe([self.root], service_monitors=self.service_monitors())
            self.assertIn(child.pid, [item['pid'] for item in result['consumers']])
            self.assertFalse(result['clear'])
        finally:
            child.terminate(); child.wait(timeout=5)

    def test_worker_reader_remains_observed_after_process_leader_exits(self):
        held = self.root / 'worker-held.txt'
        held.write_bytes(b'preserve worker reference')
        program = r'''import ctypes,threading,os,sys
ready=threading.Event()
def worker():
 with open(sys.argv[1],'rb') as held:
  print('ready',flush=True);ready.set();sys.stdin.buffer.read(1);os._exit(0)
threading.Thread(target=worker).start();ready.wait();ctypes.CDLL(None).pthread_exit(None)
'''
        child = subprocess.Popen([sys.executable, '-c', program, str(held)], cwd=self.temporary.name,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            deadline = time.monotonic() + 3
            while pathlib.Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z':
                self.assertLess(time.monotonic(), deadline, 'Synthetic process leader did not exit')
                time.sleep(0.01)
            self.assertIsNone(child.poll())
            result = guard.consumer_probe([self.root], service_monitors=self.service_monitors())
            self.assertIn(child.pid, [item['pid'] for item in result['consumers']] + result['unknownProcesses'])
            self.assertFalse(result['clear'])
            self.assertIsNone(child.poll())
            self.assertEqual(held.read_bytes(), b'preserve worker reference')
        finally:
            child.communicate(b'x', timeout=5)

    def test_mapping_remains_observed_after_its_file_descriptors_close(self):
        directory = self.root / 'mapping root\nwith space'
        directory.mkdir()
        mapped = directory / 'mapped data\nwith newline'
        mapped.write_bytes(b'preserve mapping')
        program = r'''import mmap,os,sys
file=open(sys.argv[1],'rb');mapping=mmap.mmap(file.fileno(),0,access=mmap.ACCESS_READ);file.close()
for fd in os.listdir('/proc/self/fd'):
 try:
  if os.readlink('/proc/self/fd/'+fd)==sys.argv[1]:os.close(int(fd))
 except FileNotFoundError:pass
assert mapping[:]==b'preserve mapping'
print('ready',flush=True);sys.stdin.buffer.read(1)
try:mapping.close()
except OSError:pass
'''
        child = subprocess.Popen([sys.executable, '-c', program, str(mapped)], cwd=self.temporary.name,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            result = guard.consumer_probe([directory], service_monitors=self.service_monitors())
            self.assertIn(child.pid, [item['pid'] for item in result['consumers']])
            self.assertFalse(result['clear'])
        finally:
            child.communicate(b'x', timeout=5)

    def test_local_admission_requires_a_live_exclusive_lease(self):
        primary, worktree, branch, tip, default = self.merged_task('exclusive-only')
        request = dict(branch=branch, expected_tip=tip, expected_default_tip=default, worktree=worktree,
                       service_monitors=self.service_monitors())
        with guard.WorkspaceLease(primary, 'use', 'fixture-task') as lease:
            lease.mode = 'cleanup'  # A label cannot upgrade the held OS lock.
            with self.assertRaises(guard.WorkspaceHold) as caught:
                guard.local_cleanup_admission(lease, **request)
            self.assertEqual(caught.exception.reason, 'EXCLUSIVE_LEASE_REQUIRED')
        with self.assertRaises(guard.WorkspaceHold) as caught:
            guard.local_cleanup_admission(lease, **request)
        self.assertEqual(caught.exception.reason, 'LEASE_NOT_HELD')

    def test_real_shared_leases_exclude_cleanup_but_allow_another_session(self):
        with guard.WorkspaceLease(self.root, 'use', 'fixture-parent'):
            self.assertEqual(self.child('use')[0], 0)
            code, record = self.child('cleanup')
            self.assertEqual((code, record['reason']), (3, 'WORKSPACE_IN_USE'))
        self.assertEqual(self.child('cleanup')[0], 0)

    def test_real_cleanup_lease_blocks_new_use_and_other_cleanup(self):
        with guard.WorkspaceLease(self.root, 'cleanup', 'fixture-parent'):
            for mode in ['use', 'cleanup']:
                code, record = self.child(mode)
                self.assertEqual((code, record['reason']), (3, 'WORKSPACE_IN_USE'))

    def test_inherited_descriptor_keeps_lease_after_parent_context_closes(self):
        child = None
        try:
            with guard.WorkspaceLease(self.root, 'use', 'fixture-parent') as lease:
                child = subprocess.Popen([sys.executable, '-c', 'import sys;print("ready",flush=True);sys.stdin.buffer.read(1)'],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, pass_fds=lease.child_fds())
                self.assertEqual(child.stdout.readline(), b'ready\n')
            self.assertEqual(self.child('cleanup')[0], 3)
            child.communicate(b'x', timeout=10)
            self.assertEqual(self.child('cleanup')[0], 0)
        finally:
            if child is not None and child.poll() is None:
                child.kill(); child.communicate(timeout=5)

    def test_link_and_writable_lock_inputs_are_preserved_and_rejected(self):
        canary = pathlib.Path(self.temporary.name) / 'canary'
        canary.write_text('preserve')
        self.lock.symlink_to(canary)
        self.assertEqual(self.child('use')[1]['reason'], 'UNKNOWN_LOCK_FILE')
        self.assertEqual(canary.read_text(), 'preserve')
        self.lock.unlink(); self.lock.write_text('')
        self.lock.chmod(0o666)
        self.assertEqual(self.child('cleanup')[1]['reason'], 'UNKNOWN_LOCK_FILE')
        self.assertEqual(self.lock.stat().st_mode & 0o777, 0o666)

    def test_shared_account_paths_are_not_silently_admitted_as_private_workspaces(self):
        pathlib.Path(self.temporary.name).chmod(0o755)
        code, record = self.child('use')
        self.assertEqual((code, record.get('reason')), (3, 'UNSUPPORTED_WORKSPACE_PROFILE'))
        self.assertFalse(self.lock.exists())

    def test_worktree_filesystem_is_checked_separately_from_common_git_storage(self):
        with patch.object(guard, 'filesystem_kind', side_effect=lambda path: 'nfs' if pathlib.Path(path) == self.root else 'btrfs'):
            with self.assertRaises(guard.WorkspaceHold) as caught:
                with guard.WorkspaceLease(self.root, 'use', 'fixture-parent'): pass
            self.assertEqual(caught.exception.reason, 'UNSUPPORTED_WORKSPACE_PROFILE')
        self.assertFalse(self.lock.exists())
        primary, worktree, branch, tip, default = self.merged_task('network-task')
        with patch.object(guard, 'filesystem_kind', side_effect=lambda path: 'nfs' if pathlib.Path(path) == worktree else 'btrfs'):
            with guard.WorkspaceLease(primary, 'cleanup', 'fixture-task') as lease:
                with self.assertRaises(guard.WorkspaceHold) as caught:
                    guard.local_cleanup_admission(lease, branch=branch, expected_tip=tip, expected_default_tip=default,
                                                  worktree=worktree, service_monitors=self.service_monitors())
                self.assertEqual(caught.exception.reason, 'UNSUPPORTED_WORKSPACE_PROFILE')

    def test_replaced_lock_invalidates_held_admission(self):
        with guard.WorkspaceLease(self.root, 'cleanup', 'fixture-parent') as lease:
            self.lock.unlink(); self.lock.write_text('')
            with self.assertRaises(guard.WorkspaceHold) as caught:
                lease.assert_current()
            self.assertEqual(caught.exception.reason, 'WORKSPACE_INPUT_CHANGED')

    def test_unsupported_platform_or_filesystem_fails_before_lock_creation(self):
        with patch.object(guard.platform, 'system', return_value='Darwin'):
            with self.assertRaises(guard.WorkspaceHold):
                with guard.WorkspaceLease(self.root, 'use', 'fixture-parent'): pass
            with self.assertRaises(guard.WorkspaceHold) as caught:
                guard.consumer_probe([self.root])
            self.assertEqual(caught.exception.reason, 'UNSUPPORTED_WORKSPACE_PROFILE')
        self.assertFalse(self.lock.exists())
        with patch.object(guard, 'filesystem_kind', return_value='nfs'):
            with self.assertRaises(guard.WorkspaceHold):
                with guard.WorkspaceLease(self.root, 'cleanup', 'fixture-parent'): pass
        self.assertFalse(self.lock.exists())

    def test_reentering_live_lease_cannot_lose_its_owned_descriptor(self):
        descriptor = None
        try:
            with guard.WorkspaceLease(self.root, 'use', 'fixture-parent') as lease:
                descriptor = lease.child_fds()[0]
                with self.assertRaises(guard.WorkspaceHold) as caught:
                    with lease: pass
                self.assertEqual(caught.exception.reason, 'LEASE_ALREADY_HELD')
        finally:
            if descriptor is not None:
                try: os.close(descriptor)
                except OSError: pass

    def test_real_supervisor_death_keeps_child_lease_until_owned_child_exits(self):
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)  # Test-only child subreaper.
        children_file = pathlib.Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children')
        prior = set(children_file.read_text().split())
        supervisor = None
        program = LOAD[:LOAD.index('try:')] + '''import subprocess
with guard.WorkspaceLease(sys.argv[2],'use','fixture-supervisor') as lease:
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,pass_fds=lease.child_fds())
 print(json.dumps({'child':child.pid}),flush=True)
 sys.stdin.buffer.read(1)
 child.wait()
'''
        try:
            supervisor = subprocess.Popen([sys.executable, '-c', program, str(SOURCE), str(self.root)],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertTrue(select.select([supervisor.stdout], [], [], 10)[0])
            child = json.loads(supervisor.stdout.readline())['child']
            supervisor.kill(); supervisor.communicate(timeout=5)
            self.assertIn(str(child), children_file.read_text().split())
            self.assertEqual(self.child('cleanup')[0], 3)
        finally:
            if supervisor is not None:
                if supervisor.poll() is None: supervisor.kill()
                supervisor.communicate(timeout=5)
            # Only unreaped, kernel-adopted direct children can be signalled here.
            for child in set(children_file.read_text().split()) - prior:
                pid = int(child)
                try: os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                except ChildProcessError: continue
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
                os.waitpid(pid, 0)
            self.assertEqual(libc.prctl(36, previous.value, 0, 0, 0), 0)
        self.assertEqual(self.child('cleanup')[0], 0)


if __name__ == '__main__':
    unittest.main()
