import Anthropic from '@anthropic-ai/sdk'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const fmtH = h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: CORS, status: 405 })

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables' }), { headers: CORS, status: 500 })

  const body = await req.json().catch(() => ({}))
  const {
    outlet, period,
    totalRevenue = 0, totalOrders = 0, aov = 0, growth = 0, momChange = null,
    returnRate = 0, rspGap = 0, peakDay, peakHour,
    topProducts = [], salesmen = [], categories = [], productTypes = [],
  } = body

  const prompt = `You are a sales performance analyst for ${outlet || 'a DJI store'} in Malaysia. Analyze this ${period || 'recent'} sales data and return actionable insights.

STORE METRICS
- Net Revenue: RM ${totalRevenue.toFixed(2)}
- Units Sold: ${totalOrders}
- Average Order Value: RM ${aov.toFixed(2)}
- Revenue Trend: ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%
- Month-on-Month: ${momChange !== null ? `${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%` : 'N/A'}
- Return Rate: ${returnRate.toFixed(1)}%
- RSP Discount Gap: RM ${rspGap.toFixed(2)}
- Peak Traffic: ${peakDay !== undefined ? DAYS[peakDay] : '?'} at ${peakHour !== undefined ? fmtH(peakHour) : '?'}

TOP PRODUCTS BY REVENUE
${topProducts.slice(0, 8).map((p, i) => `${i + 1}. ${p.name} — RM ${p.revenue.toLocaleString()} (${p.orders} units)`).join('\n')}

SALES TEAM
${salesmen.slice(0, 6).map((s, i) => `${i + 1}. ${s.name} — RM ${s.revenue.toLocaleString()} (${s.orders} units, ${s.returnRate}% returns)`).join('\n')}

PRODUCT CATEGORIES
${categories.slice(0, 5).map(c => `- ${c.name}: RM ${c.revenue?.toLocaleString()} (${c.orders} units)`).join('\n')}

PRODUCT TYPE MIX
${productTypes.map(t => `- ${t.name}: RM ${t.revenue?.toLocaleString()} (${t.orders} units)`).join('\n')}

Respond with ONLY a raw JSON object (no markdown, no code fences):
{
  "hotProducts": [
    { "rank": 1, "name": "exact product name from data", "revenue": 0, "units": 0, "insight": "why this product is performing well and what drives its demand" }
  ],
  "strengths": [
    { "title": "short strength title", "detail": "specific observation with numbers from the data" }
  ],
  "improvements": [
    { "area": "area name", "priority": "high or medium", "action": "specific step they should take", "detail": "why this matters with expected impact" }
  ],
  "summary": "2-3 sentence executive summary of current performance and single top recommendation"
}

Rules:
- hotProducts: pick top 3-4 by revenue/units, reference actual numbers
- strengths: 2-3 genuine positives backed by data
- improvements: 3-4 actionable items ordered by priority (high first), specific to DJI Malaysia retail
- Be direct and specific — no generic retail advice`

  try {
    const client = new Anthropic({ apiKey: key })
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = message.content[0]?.text || ''
    let analysis
    try {
      const match = text.match(/\{[\s\S]*\}/)
      analysis = JSON.parse(match ? match[0] : text)
    } catch {
      analysis = { summary: text, hotProducts: [], strengths: [], improvements: [] }
    }

    return new Response(JSON.stringify({ ok: true, analysis }), { headers: CORS })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 })
  }
}

export const config = { path: '/.netlify/functions/ai-analysis' }
