'use strict';

/**
 * 入口：初始化数据目录，仅监听 127.0.0.1，默认端口 3000；
 * 端口被占用时自动顺延尝试到 PORT+5，全部失败才退出（中文提示）。
 * 启动成功后打印数据目录绝对路径与访问地址，并默认自动打开浏览器
 * （--no-open 禁用，供自动化测试；便携启动脚本显式传 --open）。
 * 静态目录只挂 public/，数据与日志目录不对外静态暴露。
 */

const path = require('path');
const { exec, spawn } = require('child_process');
const express = require('express');
const contracts = require('./contracts');
const { ensureDir } = require('./utils/fsSafe');
const logger = require('./utils/logger');
const routes = require('./routes');

const AUTO_OPEN = !process.argv.includes('--no-open');
const MAX_PORT = contracts.PORT + 5; // 端口占用时最多顺延到该值

function openBrowser(url) {
  // 打开浏览器失败只记日志，绝不影响/退出服务
  try {
    if (process.platform === 'win32') {
      // start 需要空标题占位，url 为本机固定地址，无注入面
      exec(`start "" "${url}"`, { windowsHide: true }, (e) => {
        if (e) logger.error('open_browser', 'fail', e.message);
      });
      return;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => logger.error('open_browser', 'fail', e && e.message));
    child.unref();
  } catch (e) {
    logger.error('open_browser', 'fail', e && e.message);
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', routes.router);
  app.use(routes.errorHandler);
  return app;
}

function bootstrap() {
  [
    contracts.DATA_DIR,
    contracts.VERSION_LINES_DIR,
    contracts.SNAPSHOTS_DIR,
    contracts.CHANGES_DIR,
    contracts.RAW_FILES_DIR,
    contracts.LOGS_DIR,
  ].forEach((d) => ensureDir(d));

  const app = buildApp();

  function tryListen(port) {
    const server = app.listen(port, contracts.HOST, () => {
      const addr = `http://${contracts.HOST}:${port}`;
      logger.info('server', `started ${addr}`);
      console.log('ECT 已启动（仅本机可访问）');
      console.log('  访问地址：' + addr);
      console.log('  数据目录：' + contracts.DATA_DIR);
      if (port !== contracts.PORT) console.log(`  默认端口 ${contracts.PORT} 被占用，已改用 ${port}`);
      if (AUTO_OPEN) openBrowser(addr);
      else console.log('  （--no-open：未自动打开浏览器）');
    });
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        if (port < MAX_PORT) {
          console.log(`端口 ${port} 被占用，改用 ${port + 1} ...`);
          logger.info('server', `port_busy ${port} -> ${port + 1}`);
          tryListen(port + 1);
          return;
        }
        console.error(`启动失败：端口 ${contracts.PORT}-${MAX_PORT} 全部被占用。请关闭其它 ECT 实例或释放端口后重试。`);
        logger.error('server', 'listen_failed', 'ports all occupied');
        process.exit(1);
      }
      logger.error('server', 'listen_failed', e && e.message);
      console.error(`启动失败：${e && e.message}`);
      process.exit(1);
    });
    return server;
  }

  return tryListen(contracts.PORT);
}

module.exports = { bootstrap };

if (require.main === module) bootstrap();
