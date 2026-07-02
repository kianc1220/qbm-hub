import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: CORS, status: 405 })

  try {
    const { csvText, key, filename, outlet, period, totalTx, revenue: clientRevenue } = await req.json()

    const saveKey = process.env.STOREDASH_SAVE_KEY || 'QBM12345'
    if (key !== saveKey) return new Response(JSON.stringify({ error: 'Wrong PIN' }), { headers: CORS, status: 401 })
    if (!csvText) return new Response(JSON.stringify({ error: 'No CSV data' }), { headers: CORS, status: 400 })

    // Parse revenue from CSV header as fallback: "Total Sales : (MYR)123456.78"
    // Prefer client revenue (outlet-filtered view) over raw CSV total (all outlets)
    const revMatch = csvText.match(/Total Sales\s*:\s*\(MYR\)([\d.,]+)/i)
    const csvRevenue = revMatch ? Math.round(parseFloat(revMatch[1].replace(/,/g, ''))) : null
    const revenue = clientRevenue || csvRevenue

    // Slug the filename into a safe blob key
    const slugKey = 'file-' + (filename || 'report')
      .replace(/\.csv$/i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase()
      .slice(0, 60)

    const fileMeta = {
      key: slugKey,
      filename: filename || 'report.csv',
      outlet: outlet || '',
      period: period || '',
      totalTx: totalTx || null,
      revenue: revenue || null,
      size: csvText.length,
      savedAt: new Date().toISOString(),
    }

    const store = getStore('storedash')

    // Load and update the index (newest first, deduplicated by key)
    const indexRaw = await store.get('index')
    const existing = indexRaw ? JSON.parse(indexRaw) : []
    const updated = [fileMeta, ...existing.filter(f => f.key !== slugKey)]
    await store.set('index', JSON.stringify(updated))

    // Save the CSV under its own key
    await store.set(slugKey, csvText)

    return new Response(JSON.stringify({ success: true, key: slugKey }), { headers: CORS, status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { headers: CORS, status: 500 })
  }
}
