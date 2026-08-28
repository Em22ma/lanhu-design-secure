#!/usr/bin/env node

import {
  browserBrokerStatus,
  stopBrowserBroker,
} from "./browser-session.mjs";

function usage() {
  return "usage: node scripts/lanhu_session.mjs <status|stop>";
}

const command = process.argv[2];
if (command === "-h" || command === "--help") {
  console.log(usage());
} else if (!command || process.argv.length !== 3 || !["status", "stop"].includes(command)) {
  console.error(usage());
  process.exitCode = 2;
} else if (command === "status") {
  const status = await browserBrokerStatus();
  console.log(JSON.stringify({ status }, null, 2));
  if (["unresponsive", "incompatible"].includes(status)) process.exitCode = 1;
} else {
  const result = await stopBrowserBroker();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "stop_failed") process.exitCode = 1;
}
