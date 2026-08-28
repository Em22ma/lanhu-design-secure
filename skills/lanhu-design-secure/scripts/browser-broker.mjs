#!/usr/bin/env node

import {
  runBrowserBroker,
  shutdownBrowserBrokerServer,
} from "./browser-session.mjs";

function usage() {
  return "usage: node scripts/browser-broker.mjs --serve";
}

if (process.argv[2] !== "--serve" || process.argv.length !== 3) {
  console.error(usage());
  process.exitCode = 2;
} else {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await shutdownBrowserBrokerServer();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    await runBrowserBroker();
  } catch (error) {
    console.error(`蓝湖后台浏览器启动失败: ${error.message}`);
    process.exitCode = 1;
  }
}
