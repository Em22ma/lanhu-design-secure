#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  convertLanhuToHtml,
  convertSketchToHtml,
  localizeImageUrls,
} from "../skills/lanhu-design-secure/scripts/design-converter.mjs";

test("escapes design text in DDS and Sketch HTML", () => {
  const dds = convertLanhuToHtml({
    type: "lanhutext",
    props: { className: "title" },
    data: { value: "<b>A&B</b>" },
  });
  assert.match(dds, /&lt;b&gt;A&amp;B&lt;\/b&gt;/);
  const sketch = convertSketchToHtml({
    artboard: {
      frame: { width: 100, height: 40 },
      layers: [{
        type: "text",
        name: "Title",
        frame: { left: 0, top: 0, width: 100, height: 20 },
        content: "<i>Hello</i>",
      }],
    },
  });
  assert.match(sketch, /&lt;i&gt;Hello&lt;\/i&gt;/);
});

test("localizes all remote image URLs", () => {
  const result = localizeImageUrls(
    '<style>.hero{background-image:url("https://alipic.lanhuapp.com/bg.png?token=1")}</style>' +
      '<img class="icon" src="https://alipic.lanhuapp.com/icon.svg?token=2">',
    "Home",
  );
  assert.doesNotMatch(result.html, /https:\/\//);
  assert.equal(Object.keys(result.mapping).length, 2);
});
