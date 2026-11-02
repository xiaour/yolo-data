import path from 'node:path';

function commandArguments(commandLine, platform) {
  let remaining = String(commandLine ?? '').trim();
  const args = [];
  const pattern = platform === 'win32'
    ? /^(?:"([^"]*)"|([^\s"]+))(?=\s|$)/
    : /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/;
  while (remaining) {
    const match = remaining.match(pattern);
    if (!match) return [];
    args.push(match.slice(1).find(value => value !== undefined));
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return args;
}

export function isProjectServer(owner, { projectRoot, serverEntry, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const args = commandArguments(owner.commandLine, platform);
  const executable = paths.basename(args.shift() ?? '').toLowerCase();
  const nodeNames = ['node', 'node.exe', 'nodejs'];
  if (!nodeNames.includes(executable)) return false;
  if (owner.processName && !nodeNames.includes(String(owner.processName).toLowerCase())) return false;
  while (['--watch', '--watch-preserve-output'].includes(args[0])) args.shift();
  if (args[0] === '--') args.shift();
  const entry = args[0];
  if (!entry || entry.startsWith('-')) return false;
  const normalize = value => platform === 'win32'
    ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  if (paths.isAbsolute(entry)) return normalize(entry) === normalize(serverEntry);
  // A bare relative entry contains no evidence of its working directory.
  if (!owner.projectRoot || !paths.isAbsolute(owner.projectRoot)
    || normalize(owner.projectRoot) !== normalize(projectRoot)) return false;
  return normalize(paths.resolve(owner.projectRoot, entry)) === normalize(serverEntry);
}

export function assertProjectServerOwners(owners, config) {
  const unrelated = owners.filter(owner => !isProjectServer(owner, config));
  if (unrelated.length > 0) {
    throw new Error(`端口 ${config.port} 被非本项目进程占用（PID ${unrelated.map(owner => owner.pid).join(', ')}），为安全起见不终止。`);
  }
  return owners.filter(owner => isProjectServer(owner, config));
}
