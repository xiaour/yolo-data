import { spawn } from 'node:child_process';
import path from 'node:path';
import { prepareDevPort } from './devServerControl.mjs';
import { loadConfig } from '../src/config.js';

// 端口/监听地址以配置面为准（yolo-conf.yaml + 环境变量），不再假设默认值。
const config = loadConfig();
const port = config.port;
const host = config.host;
const projectRoot = path.resolve(config.projectRoot);
const serverEntry = path.resolve(projectRoot, 'src', 'server.js');

try {
  await prepareDevPort({ host, port, projectRoot, serverEntry });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const child = spawn(process.execPath, ['--watch', serverEntry], {
  stdio: 'inherit',
  env: { ...process.env, YOLO_DATA_PROJECT_ROOT: projectRoot },
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
