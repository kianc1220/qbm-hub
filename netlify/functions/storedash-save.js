const { getStore } = require('@netlify/blobs')

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    const { csvText, key, filename, outlet, period, totalTx } = JSON.parse(event.body || '{}')

    const saveKey = process.env.STOREDASH_SAVE_KEY || 'QBM2026'
    if (key !== saveKey) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Wrong PIN' }) }
    if (!csvText) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No CSV data' }) }

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

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) }
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) }
  }
}
