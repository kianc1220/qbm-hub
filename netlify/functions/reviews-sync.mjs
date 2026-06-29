import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
const PLACE_DATA_ID = '0x304ac1d0e4706b1f:0xebf330eb0aeab206'

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { headers: CORS, status: 405 })

  const apiKey = process.env.SERPAPI_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'SERPAPI_KEY not set in Netlify environment variables.' }), { headers: CORS, status: 503 })
  }

  // pageToken: client passes the nextPageToken from the previous call to continue paginating
  let pageToken = null
  try { const body = await req.json(); pageToken = body.pageToken || null } catch {}

  try {
    const { reviews: scraped, nextPageToken } = await fetchReviewsPage(apiKey, pageToken)

    const store = getStore('qbm-reviews')
    const [existing, cfg] = await Promise.all([
      store.get('reviews', { type: 'json' }).catch(() => null).then(v => v || []),
      store.get('settings', { type: 'json' }).catch(() => null),
    ])
    const salesmen = (cfg?.salesmen || []).map(s => s.name).filter(Boolean)
    const existingMap = new Map(existing.map(r => [r._googleKey, r]))

    let added = 0
    for (const review of scraped) {
      if (existingMap.has(review._googleKey)) {
        const ex = existingMap.get(review._googleKey)
        ex.reviewerPhoto = review.reviewerPhoto
        ex.localGuide = review.localGuide
        ex.reviewerReviewCount = review.reviewerReviewCount
        ex.images = review.images
        ex.reviewLink = review.reviewLink
        // Auto-detect salesman if not yet set
        if (!ex.salesman && salesmen.length) {
          const lower = (ex.text || '').toLowerCase()
          const match = salesmen.find(n => lower.includes(n.toLowerCase()))
          if (match) ex.salesman = match
        }
      } else {
        // Auto-detect salesman on new review
        if (salesmen.length) {
          const lower = (review.text || '').toLowerCase()
          const match = salesmen.find(n => lower.includes(n.toLowerCase()))
          if (match) review.salesman = match
        }
        existing.unshift(review)
        existingMap.set(review._googleKey, review)
        added++
      }
    }

    existing.sort((a, b) => new Date(b.date) - new Date(a.date))
    await store.setJSON('reviews', existing)

    // Record sync timestamp (only on first page to avoid overwriting mid-pagination)
    if (!pageToken) {
      await store.setJSON('last-synced', { at: new Date().toISOString() })
    }

    // Only fetch place summary on the first page (saves 1 API call per continuation)
    const summary = pageToken ? { rating: null, totalReviews: null } : await fetchPlaceSummary(apiKey)

    return new Response(JSON.stringify({
      ok: true,
      added,
      total: existing.length,
      nextPageToken,
      storeRating: summary.rating,
      storeTotalReviews: summary.totalReviews,
    }), { headers: CORS })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

async function fetchReviewsPage(apiKey, pageToken = null) {
  const params = new URLSearchParams({
    engine: 'google_maps_reviews',
    data_id: PLACE_DATA_ID,
    hl: 'en',
    sort_by: 'newestFirst',
    api_key: apiKey,
  })
  if (pageToken) params.set('next_page_token', pageToken)

  const res = await fetch(`https://serpapi.com/search.json?${params}`)
  if (!res.ok) throw new Error(`SerpAPI responded with ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`)

  return {
    reviews: parseReviews(data.reviews || []),
    nextPageToken: data.serpapi_pagination?.next_page_token || null,
  }
}

function parseReviews(raw) {
  return raw.map(r => {
    const rating = typeof r.rating === 'number' ? r.rating : parseInt(r.rating) || 0
    const name = r.user?.name || 'Anonymous'
    const text = r.snippet || r.extracted_snippet?.original || ''
    const date = parseDate(r.iso_date || r.date)
    const key = `${name}::${r.iso_date || date}::${text.slice(0, 30)}`
    return {
      id: `r_g_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      rating, reviewer: name, date, text,
      salesman: '', _source: 'google', _googleKey: key,
      addedAt: new Date().toISOString(),
      reviewerPhoto: r.user?.thumbnail || null,
      localGuide: r.user?.local_guide || false,
      reviewerReviewCount: r.user?.reviews || null,
      images: r.images || [],
      reviewLink: r.link || null,
    }
  })
}

async function fetchPlaceSummary(apiKey) {
  try {
    const params = new URLSearchParams({
      engine: 'google_maps', q: 'DJI Queensbay Mall Penang',
      data_id: PLACE_DATA_ID, hl: 'en', api_key: apiKey,
    })
    const res = await fetch(`https://serpapi.com/search.json?${params}`)
    if (!res.ok) return { rating: null, totalReviews: null }
    const data = await res.json()
    const place = data.place_results || {}
    return { rating: place.rating || null, totalReviews: place.reviews || null }
  } catch { return { rating: null, totalReviews: null } }
}

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0]
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.split('T')[0]
  const now = new Date()
  const m = dateStr.match(/(\d+)\s*(day|week|month|year)/)
  if (m) {
    const n = parseInt(m[1]), unit = m[2]
    if (unit === 'day') now.setDate(now.getDate() - n)
    else if (unit === 'week') now.setDate(now.getDate() - n * 7)
    else if (unit === 'month') now.setMonth(now.getMonth() - n)
    else if (unit === 'year') now.setFullYear(now.getFullYear() - n)
  }
  return now.toISOString().split('T')[0]
}

export const config = { path: '/.netlify/functions/reviews-sync' }
