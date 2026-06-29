import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })

  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  const store = getStore('qbm-deposits')

  const getDeposits = () =>
    store.get('deposits', { type: 'json' }).then(d => Array.isArray(d) ? d : []).catch(() => [])

  try {
    if (req.method === 'GET') {
      if (action === 'list') {
        return new Response(JSON.stringify(await getDeposits()), { headers: CORS })
      }
    }

    if (req.method === 'POST') {
      const body = await req.json()

      if (action === 'add') {
        const deposits = await getDeposits()
        const deposit = {
          id: `dep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          ...body,
          addedAt: new Date().toISOString(),
        }
        deposits.unshift(deposit)
        await store.setJSON('deposits', deposits)
        return new Response(JSON.stringify({ ok: true, deposit }), { headers: CORS })
      }

      if (action === 'bulk-add') {
        const items = Array.isArray(body) ? body : body.items
        if (!items || !items.length) return new Response(JSON.stringify({ ok: true, added: 0 }), { headers: CORS })
        const deposits = await getDeposits()
        const now = new Date().toISOString()
        const added = []
        items.forEach((item, i) => {
          const deposit = {
            id: `dep_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
            ...item,
            addedAt: now,
          }
          deposits.unshift(deposit)
          added.push(deposit)
        })
        await store.setJSON('deposits', deposits)
        return new Response(JSON.stringify({ ok: true, added: added.length, deposits: added }), { headers: CORS })
      }

      if (action === 'update') {
        const { id, ...fields } = body
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { headers: CORS, status: 400 })
        const deposits = await getDeposits()
        const idx = deposits.findIndex(d => d.id === id)
        if (idx === -1) return new Response(JSON.stringify({ error: 'Not found' }), { headers: CORS, status: 404 })
        deposits[idx] = { ...deposits[idx], ...fields, updatedAt: new Date().toISOString() }
        await store.setJSON('deposits', deposits)
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'collect') {
        const { id } = body
        const deposits = await getDeposits()
        const idx = deposits.findIndex(d => d.id === id)
        if (idx === -1) return new Response(JSON.stringify({ error: 'Not found' }), { headers: CORS, status: 404 })
        deposits[idx].status = 'collected'
        deposits[idx].collectedAt = new Date().toISOString()
        await store.setJSON('deposits', deposits)
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }

      if (action === 'delete') {
        const { id } = body
        const deposits = await getDeposits()
        await store.setJSON('deposits', deposits.filter(d => d.id !== id))
        return new Response(JSON.stringify({ ok: true }), { headers: CORS })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { headers: CORS, status: 404 })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/deposits-api' }
