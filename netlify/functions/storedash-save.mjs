import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: CORS, status: 405 })

  try {
    const { csvText, key, filename, outlet, period, totalTx } = await req.json()

    const saveKey = process.env.STOREDASH_SAVE_KEY || 'QBM12345'
    if (key !== saveKey) return new Response(JSON.stringify({ error: 'Wrong PIN' }), { headers: CORS, status: 401 })
    if (!csvText) return new Response(JSON.stringify({ error: 'No CSV data' }), { headers: CORS, status: 400 })

    const store = getStore('storedash')
    await store.set('latest-csv', csvText)
    await store.setJSON('latest-meta', {
      savedAt: new Date().toISOString(),
      size: csvText.length,
      filename: filename || 'report.csv',
      outlet: outlet || '',
      period: period || '',
      totalTx: totalTx || null,
    })

    return new Response(JSON.stringify({ success: true }), { headers: CORS, status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { headers: CORS, status: 500 })
  }
}
