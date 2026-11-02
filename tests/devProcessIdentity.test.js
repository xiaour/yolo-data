import assert from 'node:assert/strict';
import test from 'node:test';
import { isProjectServer, assertProjectServerOwners } from '../scripts/devProcessIdentity.mjs';
import { readProcessArguments, parsePortOwnerOutput } from '../scripts/devProcessOwners.mjs';

const windows = { platform: 'win32', port: 8088,
  projectRoot: 'C:\\Projects\\yolo data', serverEntry: 'C:\\Projects\\yolo data\\src\\server.js' };
const posix = { platform: 'linux', port: 8088,
  projectRoot: '/srv/yolo data', serverEntry: '/srv/yolo data/src/server.js' };

test('absolute Node entry identifies the project on Windows and POSIX', () => {
  assert.equal(isProjectServer({ processName: 'node.exe',
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" --watch "C:\\Projects\\yolo data\\src\\server.js"' }, windows), true);
  assert.equal(isProjectServer({ commandLine: 'node /srv/yolo data/src/server.js',
    argv: ['node', '/srv/yolo data/src/server.js'] }, posix), true);
  assert.equal(isProjectServer({ processName: 'NODE.EXE',
    commandLine: 'node.exe -- "c:\\projects\\YOLO DATA\\src\\server.js"' }, windows), true);
});

test('relative Node entry requires an explicit matching project root', () => {
  const owner = { processName: 'node.exe', commandLine: 'node.exe src/server.js' };
  assert.equal(isProjectServer(owner, windows), false);
  assert.equal(isProjectServer({ ...owner, projectRoot: 'C:\\Projects\\other' }, windows), false);
  assert.equal(isProjectServer({ ...owner, projectRoot: windows.projectRoot }, windows), true);
});

test('entry path must be the Node script, not a prefix or an argument to another program', () => {
  for (const owner of [
    { processName: 'node.exe', commandLine: 'node.exe "C:\\Projects\\yolo data\\src\\server.js.bak"' },
    { processName: 'node.exe', commandLine: 'node.exe other.js "C:\\Projects\\yolo data\\src\\server.js"' },
    { processName: 'node.exe', commandLine: 'node.exe -e "console.log(1)" "C:\\Projects\\yolo data\\src\\server.js"' },
    { processName: 'powershell.exe', commandLine: 'powershell.exe -File "C:\\Projects\\yolo data\\src\\server.js"' },
    { processName: 'node.exe', commandLine: 'node.exe other.js', projectRoot: windows.projectRoot },
  ]) assert.equal(isProjectServer(owner, windows), false, owner.commandLine);
});

test('POSIX project paths remain case-sensitive', () => {
  assert.equal(isProjectServer({ argv: ['node', 'src/server.js'], projectRoot: '/srv/YOLO data' }, posix), false);
  assert.equal(isProjectServer({ argv: ['node', '/srv/YOLO data/src/server.js'] }, posix), false);
});

test('mixed port owners are rejected as a group before any termination can begin', () => {
  const own = { pid: 10, processName: 'node.exe',
    commandLine: 'node.exe "C:\\Projects\\yolo data\\src\\server.js"' };
  const other = { pid: 20, processName: 'node.exe', commandLine: 'node.exe src/server.js' };
  assert.throws(() => assertProjectServerOwners([own, other], windows), /PID 20/);
  assert.deepEqual(assertProjectServerOwners([own], windows), [own]);
  assert.deepEqual(assertProjectServerOwners([], windows), []);
});

test('POSIX flattened command lines cannot prove ownership of paths containing spaces', () => {
  const config = { ...posix, projectRoot: '/srv/yolo', serverEntry: '/srv/yolo/src/server.js' };
  const commandLine = 'node /srv/yolo/src/server.js backup';
  assert.equal(isProjectServer({ commandLine }, config), false);
  assert.equal(isProjectServer({ commandLine, argv: ['node', '/srv/yolo/src/server.js backup'] }, config), false);
  assert.equal(isProjectServer({ commandLine: 'node --watch /srv/yolo data/src/server.js',
    argv: ['node', '--watch', '/srv/yolo data/src/server.js'] }, posix), true);
});

test('Linux process discovery preserves NUL-delimited argument boundaries including empty arguments', async () => {
  const argv = await readProcessArguments(123, { platform: 'linux', readFile: async (file, encoding) => {
    assert.equal(file, '/proc/123/cmdline');
    assert.equal(encoding, 'utf8');
    return 'node\0--watch\0/srv/yolo data/src/server.js\0';
  } });
  assert.equal(isProjectServer({ argv }, posix), true);
  const empty = await readProcessArguments(123, { platform: 'linux', readFile: async () => 'node\0\0/srv/yolo data/src/server.js\0' });
  assert.equal(isProjectServer({ argv: empty }, posix), false);
  assert.equal(await readProcessArguments(123, { platform: 'linux', readFile: async () => { throw new Error('access denied'); } }), null);
  assert.equal(await readProcessArguments(123, { platform: 'darwin', readFile: async () => assert.fail('no reliable argv API') }), null);
});

test('Windows discovery retains all owners returned as separate compact JSON lines', () => {
  const owners = [{ pid: 10, commandLine: 'node.exe src/server.js' }, { pid: 20, commandLine: 'other.exe' }];
  assert.deepEqual(parsePortOwnerOutput('\uFEFF' + owners.map(owner => JSON.stringify(owner)).join('\r\n')), owners);
  assert.deepEqual(parsePortOwnerOutput(JSON.stringify(owners)), owners);
  assert.deepEqual(parsePortOwnerOutput(' \r\n'), []);
  assert.throws(() => parsePortOwnerOutput('not-json'));
});
