#!/usr/bin/env node

import { closeAuthenticatedSession } from "./secure-http.mjs";
import { getDesigns } from "./lanhu-client.mjs";

function usage() {
  return 'usage: node scripts/lanhu_login.mjs "<lanhu-project-url>"\n\n打开专用蓝湖浏览器完成首次登录；无需复制 Cookie。';
}

const url = process.argv[2];
if (url === "-h" || url === "--help") {
  console.log(usage());
} else if (!url || process.argv.length > 3) {
  console.error(usage());
  process.exitCode = 2;
} else {
  try {
    const result = await getDesigns(url);
    if (result.status !== "success") throw new Error(result.message || "蓝湖认证验证失败。");
    console.log(JSON.stringify({
      status: "success",
      project_name: result.project_name,
      total_designs: result.total_designs,
      authentication: "managed-browser-session",
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", message: error.message }));
    process.exitCode = 1;
  } finally {
    await closeAuthenticatedSession();
  }
}
