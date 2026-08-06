/**
 * Supabase client: accounts, profiles, lobbies, matchmaking and signalling.
 *
 * Realtime broadcast doubles as the WebRTC signalling channel — one lobby channel carries
 * both presence and offer/answer/ICE, so there is no separate signalling server to run or
 * pay for.
 */
import { createClient } from '@supabase/supabase-js';

const URL = 'https://bgoxonxxutkporbqbtbh.supabase.co';
// Publishable key: safe to ship. Every table is guarded by row level security, and role
// and spectator changes are additionally gated by a trigger that only admins pass.
const ANON = 'sb_publishable_HtWG15aHqfYe2gFNbhTfjQ_gy86rIWU';

export const supabase = createClient(URL, ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 24 } },
});

/* ------------------------------------------------------------------- account */

export async function signUp(email, password, username) {
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { data: { username } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() { await supabase.auth.signOut(); }

export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export async function getProfile(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*, player_stats(*)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfile(id, patch) {
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

/** Active ban or timeout, or null. The DB enforces this too; this is for the UI. */
export async function activeSanction(userId) {
  const { data } = await supabase
    .from('sanctions')
    .select('*')
    .eq('user_id', userId)
    .is('lifted_at', null)
    .order('issued_at', { ascending: false });
  const now = Date.now();
  return (data ?? []).find((s) => !s.expires_at || new Date(s.expires_at).getTime() > now) ?? null;
}

/* -------------------------------------------------------------------- lobbies */

export async function createLobby({ hostId, name, visibility = 'private', maxPlayers = 10 }) {
  const { data: code } = await supabase.rpc('fl_gen_code');
  const { data, error } = await supabase.from('lobbies').insert({
    code, host_id: hostId, name, visibility, max_players: maxPlayers,
  }).select().single();
  if (error) throw error;
  await supabase.from('lobby_members').insert({
    lobby_id: data.id, user_id: hostId, is_host: true, team: 0,
  });
  return data;
}

export async function joinLobbyByCode(code, userId) {
  const { data: lobby, error } = await supabase
    .from('lobbies').select('*').eq('code', code.toUpperCase()).single();
  if (error || !lobby) throw new Error('No lobby with that code');
  if (lobby.state !== 'lobby') throw new Error('That match has already started');

  const { count } = await supabase
    .from('lobby_members').select('*', { count: 'exact', head: true }).eq('lobby_id', lobby.id);
  if ((count ?? 0) >= lobby.max_players) throw new Error('Lobby is full');

  const team = (count ?? 0) % 2;
  const { error: jErr } = await supabase.from('lobby_members')
    .upsert({ lobby_id: lobby.id, user_id: userId, team });
  if (jErr) throw jErr;
  return lobby;
}

export async function leaveLobby(lobbyId, userId) {
  await supabase.from('lobby_members').delete().eq('lobby_id', lobbyId).eq('user_id', userId);
}

export async function lobbyMembers(lobbyId) {
  const { data } = await supabase
    .from('lobby_members')
    .select('*, profiles(username, display_name, banner, level)')
    .eq('lobby_id', lobbyId);
  return data ?? [];
}

/* --------------------------------------------------------------- matchmaking */

/**
 * Joins the queue and resolves once matched.
 *
 * Matching is cooperative rather than server-side: every waiting client polls for enough
 * open tickets and the lowest ticket id creates the lobby and claims the others. That
 * avoids needing an always-on matchmaker process, at the cost of a few seconds of latency.
 */
export async function enterQueue({ userId, mmr = 2500, size = 1, mode = 'bomb', onTick }) {
  const { data: ticket, error } = await supabase.from('queue_tickets')
    .insert({ leader_id: userId, mmr, size, mode }).select().single();
  if (error) throw error;

  const started = Date.now();
  const NEEDED = 10;

  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        onTick?.(Math.round((Date.now() - started) / 1000));

        // Already claimed by someone else's match?
        const { data: mine } = await supabase
          .from('queue_tickets').select('lobby_id').eq('id', ticket.id).single();
        if (!mine) { clearInterval(poll); reject(new Error('Queue ticket lost')); return; }
        if (mine.lobby_id) {
          clearInterval(poll);
          const { data: lobby } = await supabase
            .from('lobbies').select('*').eq('id', mine.lobby_id).single();
          resolve(lobby);
          return;
        }

        const { data: open } = await supabase
          .from('queue_tickets').select('*')
          .is('lobby_id', null).eq('mode', mode)
          .order('created_at', { ascending: true }).limit(NEEDED);

        const total = (open ?? []).reduce((a, t) => a + t.size, 0);
        // Widen over time: after 45 s take whatever is waiting rather than never starting.
        const relaxed = Date.now() - started > 45000;
        const enough = total >= NEEDED || (relaxed && total >= 2);
        if (!enough) return;

        // Deterministic leader: the oldest ticket forms the lobby.
        if (open[0].id !== ticket.id) return;

        const lobby = await createLobby({
          hostId: userId, name: 'Ranked Match', visibility: 'public', maxPlayers: NEEDED,
        });
        const ids = open.map((t) => t.id);
        await supabase.from('queue_tickets').update({ lobby_id: lobby.id }).in('id', ids);
        for (const t of open) {
          if (t.leader_id === userId) continue;
          await supabase.from('lobby_members')
            .upsert({ lobby_id: lobby.id, user_id: t.leader_id, team: ids.indexOf(t.id) % 2 });
        }
        clearInterval(poll);
        resolve(lobby);
      } catch (e) {
        clearInterval(poll);
        reject(e);
      }
    }, 2500);
  });
}

export async function leaveQueue(userId) {
  await supabase.from('queue_tickets').delete().eq('leader_id', userId);
}

/* ------------------------------------------------------------- live matches */

export async function publishLiveMatch({ lobbyId, hostId, map, mode, players, allowSpec = true }) {
  await supabase.from('live_matches').upsert({
    lobby_id: lobbyId, host_id: hostId, map, mode, players, allow_spec: allowSpec,
    heartbeat: new Date().toISOString(),
  });
}

export async function heartbeatMatch(lobbyId, patch = {}) {
  await supabase.from('live_matches')
    .update({ ...patch, heartbeat: new Date().toISOString() })
    .eq('lobby_id', lobbyId);
}

export async function endLiveMatch(lobbyId) {
  await supabase.from('live_matches').delete().eq('lobby_id', lobbyId);
}

/** Matches with a heartbeat in the last 30 s — what the spectator browser lists. */
export async function listLiveMatches() {
  const since = new Date(Date.now() - 30000).toISOString();
  const { data } = await supabase
    .from('live_matches').select('*').gt('heartbeat', since)
    .order('started_at', { ascending: false });
  return data ?? [];
}

/* ------------------------------------------------------------- signalling */

/**
 * Opens a realtime channel for a lobby and adapts it to the shape Transport expects.
 * Messages are addressed: `to === '*'` broadcasts, anything else is filtered client-side
 * (broadcast has no server-side routing, and the volume here is tiny).
 */
export function openSignal(lobbyId, selfId) {
  const channel = supabase.channel(`lobby:${lobbyId}`, {
    config: { broadcast: { self: false, ack: false }, presence: { key: selfId } },
  });

  const api = {
    onMessage: null,
    onPresence: null,
    send(to, payload) {
      channel.send({ type: 'broadcast', event: 'sig', payload: { from: selfId, to, ...payload } });
    },
    async track(meta) { await channel.track(meta); },
    presenceState() { return channel.presenceState(); },
    close() { supabase.removeChannel(channel); },
  };

  channel.on('broadcast', { event: 'sig' }, ({ payload }) => {
    if (!payload || payload.from === selfId) return;
    if (payload.to !== '*' && payload.to !== selfId) return;
    api.onMessage?.(payload.from, payload);
  });
  channel.on('presence', { event: 'sync' }, () => api.onPresence?.(channel.presenceState()));

  channel.subscribe((status) => { api.status = status; });
  return api;
}

/* ------------------------------------------------------------------- admin */

export async function adminListUsers(search = '') {
  let q = supabase.from('profiles')
    .select('id, username, display_name, role, spectator, level, last_seen')
    .order('last_seen', { ascending: false }).limit(60);
  if (search) q = q.ilike('username', `%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function adminSetSpectator(userId, on) {
  const { error } = await supabase.from('profiles').update({ spectator: on }).eq('id', userId);
  if (error) throw error;
}

export async function adminSetRole(userId, role) {
  const { error } = await supabase.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

export async function adminSanction({ userId, kind, reason, minutes, issuedBy }) {
  const expires = kind === 'timeout' && minutes
    ? new Date(Date.now() + minutes * 60000).toISOString() : null;
  const { error } = await supabase.from('sanctions')
    .insert({ user_id: userId, kind, reason, expires_at: expires, issued_by: issuedBy });
  if (error) throw error;
}

export async function adminLiftSanctions(userId) {
  const { error } = await supabase.from('sanctions')
    .update({ lifted_at: new Date().toISOString() })
    .eq('user_id', userId).is('lifted_at', null);
  if (error) throw error;
}
