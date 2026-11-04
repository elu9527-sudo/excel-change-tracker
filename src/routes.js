'use strict';

/**
 * 路由层：薄，不含业务；参数校验与错误码映射（第 7.2 节 API 契约）。
 * 统一错误响应 {code, message}，不把堆栈返回给前端。
 */

const path = require('path');
const express = require('express');
const multer = require('multer');
const contracts = require('./contracts');
const logger = require('./utils/logger');
const versionLineRepo = require('./repositories/versionLineRepo');
const uploadService = require('./services/upload');
const timelineService = require('./services/timeline');
const ignoreRules = require('./services/ignoreRules');
const versionAdmin = require('./services/versionAdmin');

const router = express.Router();
const pkg = require('../package.json');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: contracts.MAX_FILE_SIZE },
});

function contractError(meta) {
  const err = new Error(meta.message);
  err.code = meta.code;
  err.http = meta.http;
  return err;
}

/**
 * 文件名解码与净化：浏览器上传的中文名在传输层可能被按 latin1 解读，
 * 需转回 UTF-8；再取 basename 防路径遍历。
 */
function decodeFileName(raw) {
  const name = String(raw || '');
  if (!name) return '';
  let looksLatin1 = true;
  for (const ch of name) {
    if (ch.codePointAt(0) > 0xff) { looksLatin1 = false; break; }
  }
  let resolved = name;
  if (looksLatin1) {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (!fixed.includes('�')) resolved = fixed;
  }
  // 只取文件名部分并净化非法字符；后缀是否合法交给上传服务按契约校验
  return path.basename(resolved).replace(/[\\/:*?"<>|]/g, '_');
}

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (mwErr) => {
    if (mwErr) {
      if (mwErr.code === 'LIMIT_FILE_SIZE') return next(contractError(contracts.ERROR_CODES.FILE_TOO_LARGE));
      return next(contractError(contracts.ERROR_CODES.INVALID_FORMAT));
    }
    if (!req.file) return next(contractError(contracts.ERROR_CODES.INVALID_FORMAT));
    try {
      const card = uploadService.handleUpload({
        fileName: decodeFileName(req.file.originalname),
        buffer: req.file.buffer,
      });
      return res.json(card);
    } catch (e) {
      return next(e);
    }
  });
});

router.get('/version-lines', (req, res, next) => {
  try {
    const items = versionLineRepo.listAll().map((o) => ({
      version_line_id: o.version_line_id,
      file_name: o.file_name,
      latest_snapshot_id: o.latest_snapshot_id,
      updated_at: o.updated_at,
    }));
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get('/timeline', (req, res, next) => {
  try {
    res.json(timelineService.getTimeline(String(req.query.version_line_id || '')));
  } catch (e) {
    next(e);
  }
});

router.get('/changes', (req, res, next) => {
  try {
    res.json(
      timelineService.queryChanges({
        version_line_id: String(req.query.version_line_id || ''),
        date_from: req.query.date_from ? String(req.query.date_from) : null,
        date_to: req.query.date_to ? String(req.query.date_to) : null,
        sheet_name: req.query.sheet_name ? String(req.query.sheet_name) : null,
        change_type: req.query.change_type ? String(req.query.change_type) : null,
        page: req.query.page,
        page_size: req.query.page_size,
        ignore: req.query.ignore ? String(req.query.ignore) : '',
      })
    );
  } catch (e) {
    next(e);
  }
});

/* ---------- 忽略规则 ---------- */

router.get('/ignore-rules', (req, res, next) => {
  try {
    const fileName = String(req.query.file_name || '');
    if (!fileName) return next(contractError(contracts.ERROR_CODES.NOT_FOUND));
    return res.json({ file_name: fileName, rules: ignoreRules.getForFile(fileName), max: ignoreRules.MAX_RULES });
  } catch (e) {
    return next(e);
  }
});

router.post('/ignore-rules', (req, res, next) => {
  try {
    const fileName = String((req.body && req.body.file_name) || '');
    if (!fileName) return next(contractError(contracts.ERROR_CODES.NOT_FOUND));
    const rules = Array.isArray(req.body && req.body.rules) ? req.body.rules : [];
    const result = ignoreRules.saveForFile(fileName, rules);
    if (!result.ok) {
      const meta = contracts.ERROR_CODES.INVALID_RULE;
      return res.status(meta.http).json({
        code: meta.code,
        message: `${meta.message}：${result.errors.join('；')}`,
        errors: result.errors,
      });
    }
    logger.info('ignore', `saved ${fileName} rules=${result.rules.length}`);
    return res.json({ file_name: fileName, rules: result.rules, max: ignoreRules.MAX_RULES });
  } catch (e) {
    return next(e);
  }
});

router.get('/context', (req, res, next) => {
  try {
    res.json(
      timelineService.getContext({
        snapshot_id: String(req.query.snapshot_id || ''),
        other_snapshot_id: req.query.other_snapshot_id ? String(req.query.other_snapshot_id) : null,
        sheet_name: String(req.query.sheet_name || ''),
        cell_ref: String(req.query.cell_ref || ''),
      })
    );
  } catch (e) {
    next(e);
  }
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', version: pkg.version, features: contracts.API_FEATURES });
});

// 删除单个版本节点：错误交给统一 errorHandler 映射 {code,message}，不返回堆栈
router.delete('/snapshots/:snapshot_id', (req, res, next) => {
  try {
    const result = versionAdmin.deleteSnapshot({
      snapshot_id: String(req.params.snapshot_id || ''),
    });
    res.status(200).json(result);
  } catch (e) {
    next(e);
  }
});

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  logger.error('http', `${req.method} ${req.path}`, err && err.message);
  const meta = Object.values(contracts.ERROR_CODES).find((m) => m.code === err.code);
  if (meta) {
    res.status(err.http || meta.http).json({ code: meta.code, message: err.message || meta.message });
  } else {
    res.status(contracts.ERROR_CODES.INTERNAL.http).json({
      code: contracts.ERROR_CODES.INTERNAL.code,
      message: contracts.ERROR_CODES.INTERNAL.message,
    });
  }
}

module.exports = { router, errorHandler };
