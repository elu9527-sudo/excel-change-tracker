'use strict';

/**
 * 安全文件工具：目录保障、原子写、安全读、ID 生成。
 * 原子写（规范 E08）：先写 .tmp 再 rename 覆盖，失败不留半成品。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeBufferAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // Windows 下目标已存在时 rename 可能 EPERM/EEXIST：删除目标后重试一次
    if (e && (e.code === 'EPERM' || e.code === 'EEXIST')) {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmpPath, filePath);
    } else {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch (_) { /* 忽略清理失败 */ }
      throw e;
    }
  }
}

function writeJsonAtomic(filePath, obj) {
  writeBufferAtomic(filePath, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
}

function writeFileAtomic(filePath, buffer) {
  writeBufferAtomic(filePath, buffer);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function newId(prefix) {
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${prefix}${Date.now()}_${rand}`;
}

module.exports = {
  ensureDir,
  writeJsonAtomic,
  writeFileAtomic,
  readJson,
  newId,
};
