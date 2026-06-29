const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

// Captured once at module load = approximately when this deploy went live
const DEPLOYED_AT = new Date().toISOString()

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })
  return new Response(JSON.stringify({ deployedAt: DEPLOYED_AT }), { headers: CORS })
}

export const config = { path: '/.netlify/functions/site-info' }
