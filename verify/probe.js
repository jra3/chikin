// String form of the probe evaluated in-page via Runtime.evaluate.
// Returns a JSON-serializable object consumed by interpretProbe.
export const PROBE_EXPRESSION = `
  (() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      languages: Array.from(navigator.languages || []),
      hasWindowChromeRuntime: !!(window.chrome && window.chrome.runtime),
      webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    };
  })()
`;

export function interpretProbe(raw) {
  const rows = [];

  const uaOk = typeof raw.userAgent === "string" && !raw.userAgent.includes("HeadlessChrome");
  rows.push({
    id: "userAgent",
    label: "User-Agent does not contain 'HeadlessChrome'",
    status: uaOk ? "pass" : "fail",
    required: true,
    value: raw.userAgent,
  });

  const wdOk = raw.webdriver === undefined || raw.webdriver === false;
  rows.push({
    id: "webdriver",
    label: "navigator.webdriver is undefined/false",
    status: wdOk ? "pass" : "fail",
    required: true,
    value: raw.webdriver,
  });

  const plOk = typeof raw.pluginsLength === "number" && raw.pluginsLength > 0;
  rows.push({
    id: "plugins",
    label: "navigator.plugins is non-empty",
    status: plOk ? "pass" : "fail",
    required: true,
    value: raw.pluginsLength,
  });

  const langOk = Array.isArray(raw.languages) && raw.languages.length > 0;
  rows.push({
    id: "languages",
    label: "navigator.languages is non-empty",
    status: langOk ? "pass" : "fail",
    required: true,
    value: raw.languages,
  });

  const chromeOk = raw.hasWindowChromeRuntime === true;
  rows.push({
    id: "windowChrome",
    label: "window.chrome.runtime is defined",
    status: chromeOk ? "pass" : "fail",
    required: true,
    value: raw.hasWindowChromeRuntime,
  });

  rows.push({
    id: "webgl",
    label: "WebGL vendor/renderer (informational — expected leak without client-side stealth)",
    status: "info",
    required: false,
    value: { vendor: raw.webglVendor, renderer: raw.webglRenderer },
  });

  return rows;
}
