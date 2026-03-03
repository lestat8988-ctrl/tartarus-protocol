/**
 * api/realtime_config.js - 브라우저용 Realtime 공개 설정
 * GET /api/realtime_config
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const channel = process.env.REALTIME_CHANNEL || 'tartarus-arena';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      ok: false,
      error: { code: 'CONFIG_ERROR', message: 'SUPABASE_URL or SUPABASE_ANON_KEY not configured' }
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    channel
  });
};
