import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: { ...CORS, 'Content-Type': 'application/json' }, status: 200 })

  try {
    const store = getStore('storedash')
    const url = new URL(req.url)
    const fileKey = url.searchParams.get('key')

    // Return index (list of all saved files)
    if (url.searchParams.get('meta') === 'true') {
      const index = (await store.get('index', { type: 'json' })) || []
      return new Response(JSON.stringify(index), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Return a specific file's CSV
    if (fileKey) {
      const csvText = await store.get(fileKey)
      if (!csvText) {
        return new Response(JSON.stringify({ error: 'File not found' }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
          status: 404,
        })
      }
      return new Response(csvText, {
        headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
        status: 200,
      })
    }

    return new Response(JSON.stringify({ error: 'Missing ?key= or ?meta=true' }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
      status: 400,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
}
