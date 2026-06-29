import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })

  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  const store = getStore('qbm-reviews')
  const PIN = process.env.STOREDASH_SAVE_KEY || 'QBM12345'

  try {
    if (req.method === 'GET') {
      if (action === 'list') {
        const data = await store.get('reviews', { type: 'json' }).catch(() => [])
        return new Response(JSON.stringify(Array.isArray(data) ? data : []), { headers: CORS })
      }
      if (action === 'settings') {
        const data = await store.get('settings', { type: 'json' }).catch(() => null)
        return new Response(JSON.stringify(data || { salesmen: [] }), { headers: CORS })
      }
      if (action === 'last-synced') {
        const data = await store.get('last-synced', { type: 'json' }).catch(() => null)
        return new Response(JSON.stringify(data || { at: null }), { headers: CORS })
      }
    }

    if (req.method === 'POST') {
      const body = await req.json()

      if (action === 'add') {
        const reviews = await store.get('reviews', { type: 'json' }).catch(() => [])
        const review = { id: `r_${Date.now()}`, ...body, addedAt: new Date().toISOString() }
        reviews.unshift(review)
        await store.setJSON('reviews', reviews)
        return new Response(JSON.stringify({ ok: true, review }), { headers: CORS })
      }

      if (action === 'attribute') {
        const { id, salesman } = body
        const reviews = await store.get('reviews', { type: 'json' }).catch(() => [])
        const idx = reviews.findIndex(r => r.id === id)
        if (idx !== -1) reviews[idx].salesman = salesman
        await store.setJSON('reviews', reviews)
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'delete') {
        if (body.pin !== PIN) return new Response(JSON.stringify({ error: 'Wrong PIN' }), { headers: CORS, status: 401 })
        const reviews = await store.get('reviews', { type: 'json' }).catch(() => [])
        await store.setJSON('reviews', reviews.filter(r => r.id !== body.id))
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'save-settings') {
        if (body.pin !== PIN) return new Response(JSON.stringify({ error: 'Wrong PIN' }), { headers: CORS, status: 401 })
        await store.setJSON('settings', body.settings)
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'dedup') {
        const reviews = await store.get('reviews', { type: 'json' }).catch(() => [])
        const seen = new Map()
        const deduped = []
        for (const r of reviews) {
          const fp = `${r.reviewer || ''}::${r.date || ''}::${(r.text || '').slice(0, 30)}`
          if (!seen.has(fp)) {
            seen.set(fp, deduped.length)
            deduped.push(r)
          } else {
            const existingIdx = seen.get(fp)
            if (!deduped[existingIdx].salesman && r.salesman) {
              deduped[existingIdx] = r
            }
          }
        }
        await store.setJSON('reviews', deduped)
        return new Response(JSON.stringify({ ok: true, before: reviews.length, after: deduped.length, removed: reviews.length - deduped.length }), { headers: CORS })
      }

      if (action === 'auto-attribute') {
        const [reviews, cfg] = await Promise.all([
          store.get('reviews', { type: 'json' }).catch(() => []),
          store.get('settings', { type: 'json' }).catch(() => null),
        ])
        const salesmen = (cfg?.salesmen || []).map(s => s.name).filter(Boolean)
        if (!salesmen.length) return new Response(JSON.stringify({ ok: true, updated: 0 }), { headers: CORS })
        let updated = 0
        for (const r of reviews) {
          if (r.salesman) continue
          const lower = (r.text || '').toLowerCase()
          const match = salesmen.find(name => lower.includes(name.toLowerCase()))
          if (match) { r.salesman = match; updated++ }
        }
        if (updated) await store.setJSON('reviews', reviews)
        return new Response(JSON.stringify({ ok: true, updated }), { headers: CORS })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { headers: CORS, status: 404 })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/reviews-api' }
