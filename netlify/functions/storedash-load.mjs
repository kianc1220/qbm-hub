import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: { ...CORS, 'Content-Type': 'application/json' }, status: 200 })

  try {
    const store = getStore('storedash')
    const url = new URL(req.url)

    if (url.searchParams.get('meta') === 'true') {
      const meta = await store.get('latest-meta', { type: 'json' })
      return new Response(JSON.stringify(meta || null), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const csvText = await store.get('latest-csv')
    if (!csvText) {
      return new Response(JSON.stringify({ error: 'No data saved yet' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: 404,
      })
    }

    return new Response(csvText, {
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
      status: 200,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
}
