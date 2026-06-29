import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })

  try {
    const store = getStore('storedash')
    const url = new URL(req.url)
    const fileKey = url.searchParams.get('key')

    // GET: list all saved files
    if (req.method === 'GET' && url.searchParams.get('meta') === 'true') {
      const indexRaw = await store.get('index')
      const index = indexRaw ? JSON.parse(indexRaw) : []
      return new Response(JSON.stringify(index), { headers: CORS, status: 200 })
    }

    // GET: fetch a specific file's CSV
    if (req.method === 'GET' && fileKey) {
      const csvText = await store.get(fileKey)
      if (!csvText) return new Response(JSON.stringify({ error: 'File not found' }), { headers: CORS, status: 404 })
      return new Response(csvText, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' }, status: 200 })
    }

    // POST: delete a file
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const delKey = body.key
      if (!delKey) return new Response(JSON.stringify({ error: 'Missing key' }), { headers: CORS, status: 400 })
      try { await store.delete(delKey) } catch {}
      const indexRaw = await store.get('index')
      const index = indexRaw ? JSON.parse(indexRaw) : []
      await store.set('index', JSON.stringify(index.filter(f => f.key !== delKey)))
      return new Response(JSON.stringify({ ok: true }), { headers: CORS, status: 200 })
    }

    return new Response(JSON.stringify({ error: 'Missing ?key= or ?meta=true' }), { headers: CORS, status: 400 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/storedash-load' }
