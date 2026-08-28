#!/usr/bin/env node

import { getDesigns } from "./lanhu-client.mjs";
import { closeAuthenticatedSession } from "./secure-http.mjs";

const url = process.argv[2];
if (url === "-h" || url === "--help") {
  console.log("usage: node scripts/get_designs.mjs <lanhu_url>");
  process.exit(0);
}

if (!url || process.argv.length > 3) {
  console.error(
    "usage: node scripts/get_designs.mjs <lanhu_url>\n\n" +
      '示例: node scripts/get_designs.mjs "https://lanhuapp.com/web/#/item/project/stage?tid=xxx&pid=xxx"',
  );
  process.exit(2);
}

try {
  const result = await getDesigns(url);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "error", message: error.message }));
  process.exitCode = 1;
} finally {
  await closeAuthenticatedSession();
}
