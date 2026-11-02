import assert from 'node:assert/strict';
import test from 'node:test';
import { isProjectServer, assertProjectServerOwners } from '../scripts/devProcessIdentity.mjs';

const windows = { platform: 'win32', port: 8088,
  projectRoot: 'C:\\Projects\\yolo data', serverEntry: 'C:\\Projects\\yolo data\\src\\server.js' };
const posix = { platform: 'linux', port: 8088,
  projectRoot: '/srv/yolo data', serverEntry: '/srv/yolo data/src/server.js' };

test('absolute Node entry identifies the project on Windows and POSIX', () => {
  assert.equal(isProjectServer({ processName: 'node.exe',
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" --watch "C:\\Projects\\yolo data\\src\\server.js"' }, windows), true);
  assert.equal(isProjectServer({ commandLine: 'node "/srv/yolo data/src/server.js"' }, posix), true);
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
  assert.equal(isProjectServer({ commandLine: 'node src/server.js', projectRoot: '/srv/YOLO data' }, posix), false);
  assert.equal(isProjectServer({ commandLine: 'node "/srv/YOLO data/src/server.js"' }, posix), false);
});

test('mixed port owners are rejected as a group before any termination can begin', () => {
  const own = { pid: 10, processName: 'node.exe',
    commandLine: 'node.exe "C:\\Projects\\yolo data\\src\\server.js"' };
  const other = { pid: 20, processName: 'node.exe', commandLine: 'node.exe src/server.js' };
  assert.throws(() => assertProjectServerOwners([own, other], windows), /PID 20/);
  assert.deepEqual(assertProjectServerOwners([own], windows), [own]);
  assert.deepEqual(assertProjectServerOwners([], windows), []);
});
