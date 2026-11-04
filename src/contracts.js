'use strict';

/**
 * 单一事实来源（规范 E01）。
 * 目录常量、服务参数、枚举、错误码、ID 前缀只允许在本文件定义；
 * 其他文件一律 require 本文件取值，不得各自硬编码目录路径或错误码字符串。
 * 权威契约：技术文档第 0 章工程规范、第 4 章模块设计、第 7 章接口设计。
 */

const path = require('path');

/* ---------- 目录常量 ---------- */

// ECT_ROOT 环境变量优先（便携包由 启动.bat 设为包目录）；
// 未设置时保持开发模式原行为完全不变：数据目录 = 进程工作目录（项目根直接启动即落项目根，
// smoke/recompute/rebuild 等脚本靠 chdir 重定向也依赖此行为）。
const ROOT_DIR = process.env.ECT_ROOT ? path.resolve(process.env.ECT_ROOT) : process.cwd();

const DATA_DIR = path.join(ROOT_DIR, 'data');
const VERSION_LINES_DIR = path.join(DATA_DIR, 'version_lines');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const CHANGES_DIR = path.join(DATA_DIR, 'changes');
const RAW_FILES_DIR = path.join(DATA_DIR, 'raw_files');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');

/* ---------- 服务参数 ---------- */

const HOST = '127.0.0.1';
const PORT = 3000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXT = ['.xlsx'];
// 上下文面板已改为"整行对照"，不再使用半径取样；保留常量仅为兼容既有验收脚本的键清单。
const CTX_RADIUS = 2;
const PAGE_SIZE = 100;
// 变更列表一次最多取多少条（前端按行聚合需要拿到整批，不能停在第一页）
const CHANGES_FETCH_MAX = 5000;
// 按行聚合后的分页大小（一行 = 一条聚合记录，展开看字段明细）
const GROUP_PAGE_SIZE = 50;
// 行标签（用于列表里指认"这是哪一行"）取值的最大展示长度
const ROW_LABEL_MAX = 48;
// 时间线卡片展开时最多渲染多少条聚合行，避免一次塞几千行
const CARD_GROUP_MAX = 100;

/* ---------- 枚举 ---------- */

const PARSE_STATUS = {
  pending: 'pending',
  parsing: 'parsing',
  success: 'success',
  compared: 'compared',
  failed: 'failed',
};

const CHANGE_TYPE = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
};

/* ---------- 错误码（code + http + message，与第 7 章错误码表一致） ---------- */

/**
 * 接口能力清单：页面会拿它和自己需要的字段比对。
 * 原因：静态页面每次从磁盘读、即时更新，但 src/* 只在进程启动时加载——
 * 升级后没重启就会出现"新页面 + 旧接口"，字段变 undefined。有这个清单就能直接提示用户重启。
 */
const API_FEATURES = ['upload_no', 'row_count', 'ignore_rules', 'formula'];

const ERROR_CODES = {
  INVALID_FORMAT: { code: 'INVALID_FORMAT', http: 400, message: '文件格式不支持，本期仅支持 .xlsx' },
  INVALID_RULE: { code: 'INVALID_RULE', http: 400, message: '忽略规则写法有误' },
  EMPTY_FILE: { code: 'EMPTY_FILE', http: 400, message: '文件为空，请检查文件' },
  FILE_TOO_LARGE: { code: 'FILE_TOO_LARGE', http: 413, message: '文件超过 20MB 上限，请压缩或拆分后重试' },
  PARSE_FAILED: { code: 'PARSE_FAILED', http: 422, message: '解析失败，文件可能已损坏；未写入任何数据' },
  NOT_FOUND: { code: 'NOT_FOUND', http: 404, message: '版本线或快照不存在，请刷新列表' },
  WRITE_FAILED: { code: 'WRITE_FAILED', http: 500, message: '落盘失败，请检查磁盘权限与剩余空间' },
  INTERNAL: { code: 'INTERNAL', http: 500, message: '未预期错误，请查看本机运行日志' },
};

/* ---------- ID 前缀 ---------- */

const ID_PREFIX = {
  VERSION_LINE: 'vl_',
  SNAPSHOT: 'snap_',
  CHANGE: 'chg_',
};

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  VERSION_LINES_DIR,
  SNAPSHOTS_DIR,
  CHANGES_DIR,
  RAW_FILES_DIR,
  LOGS_DIR,
  LOG_FILE,
  HOST,
  PORT,
  MAX_FILE_SIZE,
  ALLOWED_EXT,
  CTX_RADIUS,
  PAGE_SIZE,
  CHANGES_FETCH_MAX,
  GROUP_PAGE_SIZE,
  ROW_LABEL_MAX,
  CARD_GROUP_MAX,
  API_FEATURES,
  PARSE_STATUS,
  CHANGE_TYPE,
  ERROR_CODES,
  ID_PREFIX,
};
