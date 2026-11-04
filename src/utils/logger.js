'use strict';

/**
 * 运行日志：追加写本机日志文件（路径来自 contracts）。
 * 每行格式：ISO 时间 | 级别 | 操作 | 结果 | 错误信息
 * 任何写入失败都静默吞掉，绝不抛异常中断主流程。
 */

const fs = require('fs');
const { LOG_FILE, LOGS_DIR } = require('../contracts');
const { ensureDir } = require('./fsSafe');

function sanitize(part) {
  return String(part === undefined || part === null ? '-' : part)
    .replace(/[\r\n]+/g, ' ')
    .trim() || '-';
}

function writeLine(level, op, result, errMsg) {
  try {
    ensureDir(LOGS_DIR);
    const line = [
      new Date().toISOString(),
      level,
      sanitize(op),
      sanitize(result),
      sanitize(errMsg),
    ].join(' | ') + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    // 日志失败不影响主流程
  }
}

function info(op, result) {
  writeLine('INFO', op, result || 'ok', '-');
}

function error(op, result, errMsg) {
  writeLine('ERROR', op, result || 'fail', errMsg || '-');
}

module.exports = { info, error };
