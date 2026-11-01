import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadEnvFile, parseEnvFile } from '../src/envFile.js';
import {
  CONFIG_FILE_MAP,
  applyConfigFile,
  readConfigFile,
  resolveConfigFilePath,
} from '../src/configFile.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeTempYaml(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-conf-'));
  const file = path.join(dir, 'yolo-conf.yaml');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

test('配置文件：标量类型统一转成环境变量字符串', () => {
  const file = writeTempYaml(`
server:
  port: 9000
  host: "127.0.0.1"
auth:
  secureCookies: false
  sessionTtlHours: 8
uploads:
  allowedExtensions:
    - csv
    - xlsx
datasource:
  secretKey: ""
`);
  const { values, unknownKeys, error } = readConfigFile(file);
  assert.equal(error, null);
  assert.deepEqual(unknownKeys, []);
  assert.equal(values.PORT, '9000');
  assert.equal(values.HOST, '127.0.0.1');
  assert.equal(values.SESSION_COOKIE_SECURE, 'false');
  assert.equal(values.SESSION_TTL_HOURS, '8');
  assert.equal(values.UPLOAD_ALLOWED_EXTENSIONS, 'csv,xlsx');
  assert.equal(values.DATASOURCE_SECRET_KEY, '');
});

test('配置文件：未登记的键会被挑出来告警而不是静默生效', () => {
  const file = writeTempYaml(`
server:
  port: 8088
  prot: 9999
bootstrapDatasource:
  demo:
    enabledd: true
`);
  const { values, unknownKeys } = readConfigFile(file);
  assert.equal(values.PORT, '8088');
  assert.deepEqual(unknownKeys.sort(), ['bootstrapDatasource.demo.enabledd', 'server.prot']);
});

test('配置文件：环境变量优先，只填未设置或空串的键', () => {
  const file = writeTempYaml(`
server:
  port: 9999
models:
  model: from-yaml
  apiKey: yaml-key
`);
  const target = { PORT: '8088', MODEL: '', API_KEY: 'env-key' };
  const result = applyConfigFile({ filePath: file, target, logger: { warn() {} } });
  assert.equal(target.PORT, '8088', '已有非空环境变量不被覆盖');
  assert.equal(target.MODEL, 'from-yaml', '空串视为未设置，由配置文件补齐');
  assert.equal(target.API_KEY, 'env-key', '机密以环境变量为准');
  assert.deepEqual(result.applied.sort(), ['MODEL']);
  assert.deepEqual(result.skipped, ['PORT', 'API_KEY']);
});

test('.env 解析：支持注释、export 和带特殊字符的引号值', () => {
  assert.deepEqual(parseEnvFile(`
# comment
export API_KEY = "secret value # kept"
PLATFORM_DB_PASSWORD='p@ss word'
PORT=8088 # inline comment
`), {
    API_KEY: 'secret value # kept',
    PLATFORM_DB_PASSWORD: 'p@ss word',
    PORT: '8088',
  });
});

test('.env 优先于 yolo-conf，但不覆盖进程环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PLATFORM_DB_HOST=from-env-file\nPLATFORM_DB_PASSWORD=local-secret\n', 'utf8');
  const target = { PLATFORM_DB_HOST: '', PLATFORM_DB_PASSWORD: 'process-secret' };
  const result = loadEnvFile({ projectRoot: dir, filePath: file, target });
  assert.equal(target.PLATFORM_DB_HOST, 'from-env-file');
  assert.equal(target.PLATFORM_DB_PASSWORD, 'process-secret');
  assert.deepEqual(result.loaded, ['PLATFORM_DB_HOST']);
  assert.deepEqual(result.skipped, ['PLATFORM_DB_PASSWORD']);
});

test('配置文件：文件缺失时安静返回', () => {
  const target = {};
  const result = applyConfigFile({
    filePath: path.join(os.tmpdir(), 'not-exists-yolo-conf.yaml'),
    target,
    logger: { warn() {} },
  });
  assert.deepEqual(target, {});
  assert.deepEqual(result.applied, []);
});

test('配置文件：YAML 语法错误只告警不抛错', () => {
  const file = writeTempYaml('server: [unclosed\n');
  const warnings = [];
  const target = {};
  applyConfigFile({ filePath: file, target, logger: { warn: (msg) => warnings.push(msg) } });
  assert.equal(warnings.length >= 1, true);
  assert.match(warnings[0], /解析失败/);
  assert.deepEqual(target, {});
});

test('配置文件：仓库内的 yolo-conf.yaml 与映射表一一对应', () => {
  const template = path.join(projectRoot, 'yolo-conf.yaml');
  assert.equal(fs.existsSync(template), true, '仓库应带一份配置模板');
  const document = YAML.parse(fs.readFileSync(template, 'utf8'));
  const leaves = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node ?? {})) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, next);
      else leaves.push(next);
    }
  };
  walk(document, '');
  assert.deepEqual(
    leaves.filter((item) => !CONFIG_FILE_MAP[item]),
    [],
    '模板里不能有未登记的键',
  );
  assert.deepEqual(
    Object.keys(CONFIG_FILE_MAP).filter((item) => !leaves.includes(item)),
    [],
    '模板应覆盖全部登记项，避免新增配置项漏写',
  );
});

test('配置文件：YOLO_CONF_FILE 可覆盖默认查找路径', () => {
  const previous = process.env.YOLO_CONF_FILE;
  process.env.YOLO_CONF_FILE = './custom/conf.yaml';
  try {
    assert.equal(
      resolveConfigFilePath(projectRoot),
      path.resolve(projectRoot, 'custom', 'conf.yaml'),
    );
  } finally {
    if (previous === undefined) delete process.env.YOLO_CONF_FILE;
    else process.env.YOLO_CONF_FILE = previous;
  }
});
