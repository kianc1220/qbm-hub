import Anthropic from '@anthropic-ai/sdk'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const fmtH = h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: CORS, status: 405 })

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify env vars' }), { headers: CORS, status: 500 })

  const body = await req.json().catch(() => ({}))
  const {
    outlet, period,
    totalRevenue = 0, totalOrders = 0, aov = 0, growth = 0, momChange = null,
    returnRate = 0, rspGap = 0, peakDay, peakHour,
    topProducts = [], salesmen = [], categories = [], productTypes = [],
  } = body

  const prompt = `You are a senior sales analyst for DJI Malaysia. Analyze this ${outlet || 'QBM'} store data and benchmark it against the Malaysian DJI retail market.

## MALAYSIA DJI RETAIL BENCHMARKS (for comparison)
- Typical outlet monthly revenue: RM 80k–200k; top performers (KLCC, Pavilion KL, 1U): RM 250k–450k
- Average return rate across Malaysian outlets: 3%–6%
- Average order value (AOV): RM 1,400–2,200
- Typical product mix: ~55% Drone, ~35% Handheld, ~10% Others
- Typical RSP gap: 2%–5% of gross
- Drone category leaders nationally: DJI Mini 4 Pro, DJI Air 3, DJI Neo
- Handheld leaders nationally: Osmo Pocket 3, Osmo Action 5 Pro, DJI Mic 2
- Peak trading days: Saturday & Sunday (usually 1.5–2× weekday avg)

## THIS STORE: ${outlet || 'QBM'} — ${period || 'recent period'}
Revenue: RM ${totalRevenue.toFixed(0)}  |  Units: ${totalOrders}  |  AOV: RM ${aov.toFixed(0)}
Revenue trend: ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%  |  MoM: ${momChange !== null ? `${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%` : 'N/A'}
Return rate: ${returnRate.toFixed(1)}%  |  RSP gap: RM ${rspGap.toFixed(0)}
Peak: ${peakDay !== undefined ? DAYS[peakDay] : '?'} ${peakHour !== undefined ? fmtH(peakHour) : ''}

TOP PRODUCTS
${topProducts.slice(0, 8).map((p, i) => `${i + 1}. ${p.name} — RM ${p.revenue.toLocaleString()} (${p.orders} units)`).join('\n')}

TEAM
${salesmen.slice(0, 6).map((s, i) => `${i + 1}. ${s.name} — RM ${s.revenue.toLocaleString()} (${s.orders} units, ${s.returnRate}% returns)`).join('\n')}

CATEGORY MIX
${categories.slice(0, 5).map(c => `${c.name}: RM ${c.revenue?.toLocaleString()} (${c.orders} units)`).join('\n')}

PRODUCT TYPE MIX
${productTypes.map(t => `${t.name}: RM ${t.revenue?.toLocaleString()} (${t.orders} units)`).join('\n')}

Return ONLY a raw JSON object — no markdown, no code fences:
{
  "summary": "2 punchy sentences: overall verdict + single top recommendation",
  "vsMarket": {
    "revenuePosition": "top tier|above average|average|below average",
    "aovPosition": "above average|average|below average",
    "returnRatePosition": "excellent|good|average|needs attention",
    "insight": "1-2 sentences comparing this store to Malaysia DJI benchmarks with specific numbers"
  },
  "hotProducts": [
    { "rank": 1, "name": "exact name", "revenue": 0, "units": 0, "badge": "Best Seller|Fast Mover|High Value|Growing", "insight": "One sharp sentence on why it's hot" }
  ],
  "strengths": [
    { "title": "3–5 word title", "detail": "One specific sentence with numbers" }
  ],
  "improvements": [
    { "priority": "high|medium", "area": "area name", "action": "One clear action sentence", "impact": "Expected result in 1 line" }
  ]
}

Rules: hotProducts = top 3–4. strengths = 2–3. improvements = 3–4 ordered high→medium. Be specific and direct, no fluff.`

  try {
    const client = new Anthropic({ apiKey: key })
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    })

    const raw = message.content[0]?.text || ''
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let analysis
    try {
      const match = text.match(/\{[\s\S]*\}/)
      analysis = JSON.parse(match ? match[0] : text)
    } catch {
      analysis = { summary: raw, vsMarket: null, hotProducts: [], strengths: [], improvements: [] }
    }

    return new Response(JSON.stringify({ ok: true, analysis }), { headers: CORS })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/ai-analysis' }
