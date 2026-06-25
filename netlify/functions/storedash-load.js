const { getStore } = require('@netlify/blobs')

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: '' }

  try {
    const store = getStore('storedash')

    if (event.queryStringParameters?.meta === 'true') {
      const meta = await store.get('latest-meta', { type: 'json' })
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(meta || null),
      }
    }

    const csvText = await store.get('latest-csv')
    if (!csvText) return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No data saved yet' }) }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' },
      body: csvText,
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    }
  }
}
