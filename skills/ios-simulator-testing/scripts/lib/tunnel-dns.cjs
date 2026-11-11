// Scoped preload: preserve system DNS; retry only unresolved Quick Tunnel hosts via DoH.
const dns = require('node:dns');
const https = require('node:https');
const { isIP } = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const cache = new Map();

function resolveTunnel(hostname, family) {
  const type = family === 6 ? 28 : 1;
  const key = `${hostname}:${type}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.records);
  return new Promise((resolve, reject) => {
    const request = https.get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, timeout: 5000,
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
        if (data.length > 65536) request.destroy(new Error('DNS response exceeds limit'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('DNS resolver unavailable');
          const reply = JSON.parse(data);
          const records = (reply.Answer ?? []).filter((answer) => answer.type === type && isIP(answer.data) === (type === 28 ? 6 : 4))
            .map((answer) => ({ address: answer.data, family: type === 28 ? 6 : 4 }));
          if (reply.Status !== 0 || !records.length) throw new Error('Tunnel hostname unresolved');
          if (cache.size >= 100) cache.clear();
          cache.set(key, { records, until: Date.now() + 60000 });
          resolve(records);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DNS resolver timed out')));
    request.on('error', reject);
  });
}

function createLookup(original, resolveFallback = resolveTunnel) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const settings = typeof options === 'number' ? { family: options } : (options ?? {});
    original(hostname, options, (error, address, family) => {
      if (!error || error.code !== 'ENOTFOUND' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname)) {
        callback(error, address, family);
        return;
      }
      resolveFallback(hostname, settings.family).then((records) => {
        if (settings.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }, () => callback(error));
    });
  };
}

if (!dns.lookup.__simulatorTunnelFallback) {
  dns.lookup = createLookup(dns.lookup.bind(dns));
  dns.lookup.__simulatorTunnelFallback = true;
  syncBuiltinESMExports();
}
module.exports = { createLookup };
