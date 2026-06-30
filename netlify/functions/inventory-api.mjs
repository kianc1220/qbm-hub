import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })

  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  const store = getStore('qbm-inventory')
  const PIN = process.env.STOREDASH_SAVE_KEY || 'QBM12345'

  try {
    if (req.method === 'GET') {
      if (action === 'list') {
        const data = await store.get('items', { type: 'json' }).catch(() => [])
        return new Response(JSON.stringify(Array.isArray(data) ? data : []), { headers: CORS })
      }
    }

    if (req.method === 'POST') {
      const body = await req.json()
      if (body.pin !== PIN) return new Response(JSON.stringify({ error: 'Wrong PIN' }), { headers: CORS, status: 401 })

      if (action === 'save') {
        const items = await store.get('items', { type: 'json' }).catch(() => [])
        const item = { ...body.item, updatedAt: new Date().toISOString() }
        if (!item.id) item.id = `item_${Date.now()}`
        const idx = items.findIndex(i => i.id === item.id)
        if (idx !== -1) {
          item.firstAddedAt = items[idx].firstAddedAt || item.updatedAt
          items[idx] = item
        } else {
          item.firstAddedAt = item.updatedAt
          items.push(item)
        }
        await store.setJSON('items', items)
        return new Response(JSON.stringify({ ok: true, item }), { headers: CORS })
      }

      if (action === 'delete') {
        const items = await store.get('items', { type: 'json' }).catch(() => [])
        await store.setJSON('items', items.filter(i => i.id !== body.id))
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'bulk') {
        const existing = await store.get('items', { type: 'json' }).catch(() => []) || []
        const existingBySku = new Map(existing.filter(e => e.sku).map(e => [e.sku, e]))
        const now = new Date().toISOString()
        const items = (body.items || []).map((item, i) => {
          const prior = item.sku ? existingBySku.get(item.sku) : null
          return {
            ...item,
            id: item.id || prior?.id || `item_${Date.now()}_${i}`,
            updatedAt: now,
            firstAddedAt: prior?.firstAddedAt || now,
          }
        })
        await store.setJSON('items', items)
        return new Response(JSON.stringify({ ok: true, count: items.length }), { headers: CORS })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { headers: CORS, status: 404 })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/inventory-api' }
