#!/usr/bin/env node

import {
  convertLanhuToHtml,
  convertSketchToHtml,
  detectDesignScale,
  extractDesignTokens,
  extractFullAnnotationsFromSketch,
  extractLayerAnnotationsFromSketch,
  minifyHtml,
  localizeImageUrls,
} from "./design-converter.mjs";

export function buildDesignSpecs(schemaResult, { minify = true } = {}) {
  const {
    schema,
    sketchData,
    design,
    source,
    ddsError,
    designImageUrl,
    canvasSize,
    versionId,
  } = schemaResult;
  const designScale = detectDesignScale(sketchData, canvasSize);
  const rawHtml = source === "dds" && schema
    ? convertLanhuToHtml(schema)
    : convertSketchToHtml(sketchData, designScale, designImageUrl);
  const preparedHtml = minify ? minifyHtml(rawHtml) : rawHtml;
  const localized = localizeImageUrls(preparedHtml, design.name);
  const designTokens = extractDesignTokens(sketchData);
  const sketchAnnotations = source === "sketch"
    ? extractFullAnnotationsFromSketch(sketchData, designScale)
    : "";
  const layerCssAnnotations = source === "sketch"
    ? extractLayerAnnotationsFromSketch(sketchData, designScale)
    : [];

  const sourceGuidance = source === "dds"
    ? "source=dds（高保真）：html 字段是布局结构和所有 CSS 数值的权威来源，直接复用、不得主观修改；design_tokens 补充渐变/阴影/非均匀圆角等；原图仅用于核对布局是否错位。"
    : "source=sketch（降级，DDS Schema 不可用）：html 仅为绝对定位的元素清单，不能当作布局权威。请以设计图原图为布局结构的主力参考，以 design_tokens / sketch_annotations / layer_css_annotations / HTML data-css 的原始数值为精确数值来源。强烈建议先下载并查看原图再还原。";

  return {
    status: "success",
    source,
    version: versionId,
    source_guidance: sourceGuidance,
    design_id: design.id,
    design_name: design.name,
    design_scale: designScale,
    canvas_size: canvasSize,
    html: localized.html,
    design_tokens: designTokens || null,
    sketch_annotations: sketchAnnotations || null,
    layer_css_annotations: layerCssAnnotations.length ? layerCssAnnotations : null,
    image_url_mapping: localized.mapping,
    total_images: Object.keys(localized.mapping).length,
    dds_error: ddsError || null,
  };
}
