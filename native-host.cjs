const path = require('node:path');

/**
 * Loads the native Rust module and keeps its background Tokio runtime alive.
 */
function main() {
  const nativeModuleName = process.env.PROXY_NATIVE_MODULE || 'proxy_rs.node';
  const nativeModulePath = path.join(__dirname, 'target', 'release', nativeModuleName);
  const { startProxy } = require(nativeModulePath);
  startProxy();
  console.log(`Rust native proxy hosted by Node on port ${process.env.PORT || '80'}`);
  const keepAlive = setInterval(() => {}, 2 ** 30);
  const shutdown = () => { clearInterval(keepAlive); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
