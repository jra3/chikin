export function parseArgs(argv) {
  const out = {
    host: "http://localhost:9222",
    json: false,
    skipSannysoft: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") {
      out.host = argv[++i];
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--skip-sannysoft") {
      out.skipSannysoft = true;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}
