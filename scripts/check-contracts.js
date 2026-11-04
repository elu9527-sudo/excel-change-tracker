'use strict';

/**
 * E01 单一事实来源验收（退出码 0 = 通过）：
 * 1) 断言 contracts.js 所需键齐全（目录、参数、枚举、错误码、ID 前缀）；
 * 2) 扫描 src/ 下除 contracts.js 以外的源码，出现硬编码目录字面量
 *    （如 'data/'、'data'）或错误码字符串字面量（如 "PARSE_FAILED"）即报错退出 1。
 */

const fs = require('fs');
const path = require('path');
const contracts = require('../src/contracts');

const problems = [];

/* ---------- 1. contracts 键完整性 ---------- */

const REQUIRED_KEYS = [
  'ROOT_DIR', 'DATA_DIR', 'VERSION_LINES_DIR', 'SNAPSHOTS_DIR', 'CHANGES_DIR',
  'RAW_FILES_DIR', 'LOGS_DIR', 'LOG_FILE',
  'HOST', 'PORT', 'MAX_FILE_SIZE', 'ALLOWED_EXT', 'CTX_RADIUS', 'PAGE_SIZE',
  'PARSE_STATUS', 'CHANGE_TYPE', 'ERROR_CODES', 'ID_PREFIX',
];
for (const k of REQUIRED_KEYS) {
  if (contracts[k] === undefined) problems.push(`contracts.js 缺少键：${k}`);
}

for (const k of ['pending', 'parsing', 'success', 'compared', 'failed']) {
  if (!contracts.PARSE_STATUS || contracts.PARSE_STATUS[k] === undefined) {
    problems.push(`PARSE_STATUS 缺少取值：${k}`);
  }
}
for (const k of ['added', 'modified', 'deleted']) {
  if (!contracts.CHANGE_TYPE || contracts.CHANGE_TYPE[k] === undefined) {
    problems.push(`CHANGE_TYPE 缺少取值：${k}`);
  }
}
for (const k of ['INVALID_FORMAT', 'EMPTY_FILE', 'FILE_TOO_LARGE', 'PARSE_FAILED', 'NOT_FOUND', 'WRITE_FAILED', 'INTERNAL']) {
  const m = contracts.ERROR_CODES && contracts.ERROR_CODES[k];
  if (!m || m.code === undefined || m.http === undefined || m.message === undefined) {
    problems.push(`ERROR_CODES.${k} 缺失或不含 code/http/message`);
  }
}
for (const k of ['VERSION_LINE', 'SNAPSHOT', 'CHANGE']) {
  if (!contracts.ID_PREFIX || !contracts.ID_PREFIX[k]) {
    problems.push(`ID_PREFIX 缺少前缀：${k}`);
  }
}

/* ---------- 2. src/ 硬编码扫描 ---------- */

function listJs(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) listJs(fp, out);
    else if (name.endsWith('.js') && name !== 'contracts.js') out.push(fp);
  }
  return out;
}

const srcDir = path.join(__dirname, '..', 'src');
const files = listJs(srcDir, []);
const codeNames = Object.keys(contracts.ERROR_CODES || {});
const dirPatterns = [/[`'"]data[\\/]/, /[`'"]data[`'"]/];

for (const fp of files) {
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const where = `${path.relative(srcDir, fp)}:${idx + 1}`;
    for (const re of dirPatterns) {
      if (re.test(line)) problems.push(`${where} 硬编码目录字面量（应从 contracts 取常量）：${line.trim()}`);
    }
    for (const name of codeNames) {
      const re = new RegExp("[`'\"]" + name + "[`'\"]");
      if (re.test(line)) problems.push(`${where} 硬编码错误码字符串：${name}（应从 contracts.ERROR_CODES 取）`);
    }
  });
}

/* ---------- 结果 ---------- */

if (problems.length) {
  console.error(`check-contracts 未通过（${problems.length} 处问题）：`);
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`check-contracts 通过：contracts 键完整；扫描 src/ 下 ${files.length} 个文件，未发现硬编码目录/错误码。`);
process.exit(0);
