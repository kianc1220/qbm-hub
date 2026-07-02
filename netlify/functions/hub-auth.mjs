import { getStore } from '@netlify/blobs'
import { createHash, randomBytes } from 'node:crypto'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
const j = (o, s = 200) => new Response(JSON.stringify(o), { headers: CORS, status: s })
const hash = (salt, pin) => createHash('sha256').update(salt + ':' + pin).digest('hex')

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS, status: 200 })

  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  const store = getStore('qbm-hub-auth')

  const getUsers = async () => (await store.get('users', { type: 'json' }).catch(() => null)) || []
  const getSessions = async () => (await store.get('sessions', { type: 'json' }).catch(() => null)) || {}
  const getSettings = async () => (await store.get('settings', { type: 'json' }).catch(() => null)) || {}

  const auth = async (token) => {
    if (!token) return null
    const sessions = await getSessions()
    const s = sessions[token]
    if (!s || s.exp < Date.now()) return null
    return s
  }

  try {
    // Public: maintenance status (homepage checks this before render)
    if (action === 'maintenance' && req.method === 'GET') {
      const settings = await getSettings()
      return j({ maintenance: settings.maintenance || { on: false, message: '' }, tools: settings.tools || {} })
    }

    if (action === 'verify' && req.method === 'GET') {
      const s = await auth(url.searchParams.get('token'))
      return s ? j({ ok: true, user: { username: s.username, role: s.role, name: s.name } }) : j({ ok: false }, 401)
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))

      if (action === 'login') {
        const { username, pin } = body
        let users = await getUsers()
        // Bootstrap: first ever login as "admin" with the hub PIN creates the admin account
        if (users.length === 0) {
          const bootPin = process.env.HUB_ADMIN_KEY || process.env.STOREDASH_SAVE_KEY || 'QBM12345'
          if ((username || '').toLowerCase() === 'admin' && pin === bootPin) {
            const salt = randomBytes(8).toString('hex')
            users = [{ username: 'admin', name: 'Admin', role: 'admin', salt, pinHash: hash(salt, pin), createdAt: new Date().toISOString() }]
            await store.setJSON('users', users)
          }
        }
        const u = users.find(x => x.username.toLowerCase() === (username || '').toLowerCase())
        if (!u || hash(u.salt, pin || '') !== u.pinHash) return j({ error: 'Wrong username or PIN' }, 401)
        const token = randomBytes(24).toString('hex')
        const sessions = await getSessions()
        for (const t of Object.keys(sessions)) if (sessions[t].exp < Date.now()) delete sessions[t]
        sessions[token] = { username: u.username, role: u.role, name: u.name, exp: Date.now() + 30 * 86400000 }
        await store.setJSON('sessions', sessions)
        return j({ token, user: { username: u.username, role: u.role, name: u.name } })
      }

      if (action === 'logout') {
        const sessions = await getSessions()
        delete sessions[body.token]
        await store.setJSON('sessions', sessions)
        return j({ ok: true })
      }

      const s = await auth(body.token)
      if (!s) return j({ error: 'Not logged in' }, 401)

      if (action === 'change-pin') {
        const users = await getUsers()
        const u = users.find(x => x.username === s.username)
        if (!u || hash(u.salt, body.oldPin || '') !== u.pinHash) return j({ error: 'Wrong current PIN' }, 401)
        if (!body.newPin || body.newPin.length < 4) return j({ error: 'New PIN too short (min 4)' }, 400)
        u.salt = randomBytes(8).toString('hex')
        u.pinHash = hash(u.salt, body.newPin)
        await store.setJSON('users', users)
        return j({ ok: true })
      }

      // Admin-only actions below
      if (s.role !== 'admin') return j({ error: 'Admin only' }, 403)

      if (action === 'list-users') {
        const users = await getUsers()
        return j(users.map(({ username, name, role, createdAt }) => ({ username, name, role, createdAt })))
      }

      if (action === 'add-user') {
        const { username, name, pin, role } = body
        if (!username || !pin) return j({ error: 'Username and PIN required' }, 400)
        if (pin.length < 4) return j({ error: 'PIN too short (min 4)' }, 400)
        const users = await getUsers()
        if (users.some(x => x.username.toLowerCase() === username.toLowerCase())) return j({ error: 'User already exists' }, 400)
        const salt = randomBytes(8).toString('hex')
        users.push({ username: username.trim(), name: (name || username).trim(), role: role === 'admin' ? 'admin' : 'staff', salt, pinHash: hash(salt, pin), createdAt: new Date().toISOString() })
        await store.setJSON('users', users)
        return j({ ok: true })
      }

      if (action === 'delete-user') {
        if (body.username === s.username) return j({ error: "You can't delete yourself" }, 400)
        let users = await getUsers()
        users = users.filter(x => x.username !== body.username)
        await store.setJSON('users', users)
        const sessions = await getSessions()
        for (const t of Object.keys(sessions)) if (sessions[t].username === body.username) delete sessions[t]
        await store.setJSON('sessions', sessions)
        return j({ ok: true })
      }

      if (action === 'reset-pin') {
        const users = await getUsers()
        const u = users.find(x => x.username === body.username)
        if (!u) return j({ error: 'User not found' }, 404)
        if (!body.pin || body.pin.length < 4) return j({ error: 'PIN too short (min 4)' }, 400)
        u.salt = randomBytes(8).toString('hex')
        u.pinHash = hash(u.salt, body.pin)
        await store.setJSON('users', users)
        return j({ ok: true })
      }

      if (action === 'set-role') {
        if (body.username === s.username) return j({ error: "You can't change your own role" }, 400)
        const users = await getUsers()
        const u = users.find(x => x.username === body.username)
        if (!u) return j({ error: 'User not found' }, 404)
        u.role = body.role === 'admin' ? 'admin' : 'staff'
        await store.setJSON('users', users)
        return j({ ok: true })
      }

      if (action === 'set-maintenance') {
        const settings = await getSettings()
        settings.maintenance = { on: !!body.on, message: body.message || '' }
        await store.setJSON('settings', settings)
        return j({ ok: true })
      }

      if (action === 'set-tool-maintenance') {
        const settings = await getSettings()
        settings.tools = settings.tools || {}
        settings.tools[body.tool] = { maintenance: !!body.on }
        await store.setJSON('settings', settings)
        return j({ ok: true })
      }
    }

    return j({ error: 'Not found' }, 404)
  } catch (e) {
    return j({ error: e.message }, 500)
  }
}

export const config = { path: '/.netlify/functions/hub-auth' }
