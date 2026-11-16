import DOMPurify from "../vendor/purify.es.mjs";

const FORBID_TAGS = ["script", "iframe", "object", "embed", "foreignObject", "audio", "video"];
const FORBID_ATTR = ["srcdoc"];

const HTML_OPTIONS = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_ATTR: ["target", "rel", "data-copy", "data-modal-src", "data-modal-cap"],
  FORBID_TAGS,
  FORBID_ATTR,
};

const SVG_OPTIONS = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS,
  FORBID_ATTR,
};

export function createSanitizer(purify = DOMPurify) {
  const sanitize = (dirty, options) => {
    if (!purify || typeof purify.sanitize !== "function") {
      throw new Error("DOM sanitizer is unavailable");
    }
    return purify.sanitize(String(dirty ?? ""), options);
  };

  return {
    html(dirty) {
      return sanitize(dirty, HTML_OPTIONS);
    },
    svg(dirty) {
      return sanitize(dirty, SVG_OPTIONS);
    },
  };
}

export const sanitizer = createSanitizer();

export function sanitizeHtml(dirty) {
  return sanitizer.html(dirty);
}

export function sanitizeSvg(dirty) {
  return sanitizer.svg(dirty);
}
