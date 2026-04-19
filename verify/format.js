export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

export function formatPretty(result) {
  const { rows, sannysoft } = result;
  const lines = [];
  lines.push("chikin verification");
  lines.push("===================");
  for (const r of rows) {
    const marker =
      r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "INFO";
    const val = typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value);
    lines.push(`  [${marker}] ${r.label}`);
    lines.push(`         value: ${val}`);
  }
  const required = rows.filter((r) => r.required);
  const passed = required.filter((r) => r.status === "pass").length;
  lines.push("");
  lines.push(`Summary: ${passed}/${required.length} required checks passed`);

  if (sannysoft) {
    lines.push("");
    lines.push("sannysoft results");
    lines.push("-----------------");
    for (const row of sannysoft) {
      lines.push(`  ${row.label}: ${row.result}`);
    }
  }

  return lines.join("\n");
}
