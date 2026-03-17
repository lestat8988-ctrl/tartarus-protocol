const express = require('express');
const PORT = process.env.PORT || 8787;
const UPSTREAM = 'https://tartarus-project.vercel.app';

const app = express();
app.use(express.json());

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('*', (req, res) => {
  cors(res);
  res.status(204).end();
});

function hasBody(method) {
  return ['POST', 'PUT', 'PATCH'].indexOf(String(method).toUpperCase()) >= 0;
}

async function proxyEp1(req, res, path) {
  cors(res);
  try {
    const method = req.method;
    const qs = new URLSearchParams(req.query || {}).toString();
    const upstreamUrl = UPSTREAM + path + (qs ? '?' + qs : '');
    const opts = { method };
    if (hasBody(method)) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(req.body || {});
    }
    const upstreamRes = await fetch(upstreamUrl, opts);
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    res.status(upstreamRes.status);
    const text = await upstreamRes.text();
    res.send(text);
    console.log(method + ' ' + req.path, '->', upstreamUrl, '->', upstreamRes.status);
  } catch (err) {
    cors(res);
    res.status(500).json({ ok: false, error: 'proxy failed', detail: String(err.message || err) });
  }
}

app.all('/api/ep1/action', (req, res) => proxyEp1(req, res, '/api/ep1/action'));
app.all('/api/ep1/state', (req, res) => proxyEp1(req, res, '/api/ep1/state'));
app.all('/api/ep1/result', (req, res) => proxyEp1(req, res, '/api/ep1/result'));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, service: 'itch-proxy' });
});
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'itch-proxy' });
});

app.listen(PORT, () => {
  console.log('itch-proxy listening on http://localhost:' + PORT);
});
