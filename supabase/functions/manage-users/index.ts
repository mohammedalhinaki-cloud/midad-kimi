// Midad — manage-users Edge Function
// Privileged account operations that must never run in the browser:
// member creation, PIN assignment/reset, assistant-admin management,
// status changes, permanent deletion, and one-time super-admin bootstrap.
// The service-role key stays server-side (auto-provided by Supabase).
// @ts-nocheck
import { createClient } from 'jsr:@supabase/supabase-js@2';

const PIN_SUFFIX = 'MD'; // internal mapping: 4-digit PIN -> 6+ char Auth password

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}
function validPhone(phone: unknown): phone is string {
  return typeof phone === 'string' && /^\+9665\d{8}$/.test(phone);
}
function validEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // ---------- one-time bootstrap of the first super administrator ----------
    // No login required, but permanently disabled once a super_admin exists.
    if (action === 'bootstrap_super_admin') {
      const { data: existing } = await admin
        .from('profiles').select('id').eq('role', 'super_admin').limit(1);
      if (existing && existing.length > 0) return json({ error: 'bootstrap_disabled' }, 403);
      const { full_name, email, password } = body;
      if (!full_name || !validEmail(email) || typeof password !== 'string' || password.length < 6) {
        return json({ error: 'invalid_input' }, 400);
      }
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message || 'create_failed' }, 400);
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user.id, role: 'super_admin', full_name, email, status: 'active',
      });
      if (pErr) return json({ error: pErr.message }, 400);
      await admin.from('activity_logs').insert({
        actor_id: created.user.id, action: 'bootstrap_super_admin',
        target_type: 'profile', target_id: created.user.id, details: { full_name },
      });
      return json({ ok: true, id: created.user.id });
    }

    // ---------- authenticate the caller ----------
    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json({ error: 'unauthorized' }, 401);
    const { data: caller } = await admin.from('profiles').select('*').eq('id', user.id).single();
    if (!caller) return json({ error: 'profile_not_found' }, 403);
    if (caller.role === 'member') return json({ error: 'forbidden' }, 403);
    if (caller.status !== 'active') return json({ error: 'account_not_active' }, 403);
    const isSuper = caller.role === 'super_admin';

    async function log(actionName: string, targetType: string, targetId: string, details: unknown) {
      await admin.from('activity_logs').insert({
        actor_id: caller.id, action: actionName,
        target_type: targetType, target_id: targetId, details,
      });
    }

    // ---------- create member (admins) ----------
    if (action === 'create_member') {
      const { full_name, phone, pin } = body;
      if (!full_name || !validPhone(phone) || !validPin(pin)) return json({ error: 'invalid_input' }, 400);
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        phone, password: pin + PIN_SUFFIX, phone_confirm: true, user_metadata: { full_name },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message || 'create_failed' }, 400);
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user.id, role: 'member', full_name, phone, status: 'active',
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: pErr.message }, 400);
      }
      await admin.from('member_status_history').insert({
        member_id: created.user.id, status: 'active', changed_by: caller.id, note: 'member_created',
      });
      await log('create_member', 'profile', created.user.id, { full_name, phone });
      return json({ ok: true, id: created.user.id });
    }

    // ---------- reset member PIN (admins) ----------
    if (action === 'reset_pin') {
      const { member_id, pin } = body;
      if (!member_id || !validPin(pin)) return json({ error: 'invalid_input' }, 400);
      const { data: target } = await admin.from('profiles').select('*').eq('id', member_id).single();
      if (!target || target.role !== 'member') return json({ error: 'target_not_found' }, 404);
      const { error: uErr2 } = await admin.auth.admin.updateUserById(member_id, { password: pin + PIN_SUFFIX });
      if (uErr2) return json({ error: uErr2.message }, 400);
      await log('reset_pin', 'profile', member_id, {});
      return json({ ok: true });
    }

    // ---------- create assistant admin (super admin only) ----------
    if (action === 'create_assistant') {
      if (!isSuper) return json({ error: 'forbidden' }, 403);
      const { full_name, email, password } = body;
      if (!full_name || !validEmail(email) || typeof password !== 'string' || password.length < 6) {
        return json({ error: 'invalid_input' }, 400);
      }
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message || 'create_failed' }, 400);
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user.id, role: 'assistant_admin', full_name, email, status: 'active',
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: pErr.message }, 400);
      }
      await log('create_assistant', 'profile', created.user.id, { full_name, email });
      return json({ ok: true, id: created.user.id });
    }

    // ---------- update profile (name / phone / email) ----------
    if (action === 'update_profile') {
      const { id, full_name, phone, email } = body;
      if (!id) return json({ error: 'invalid_input' }, 400);
      const { data: target } = await admin.from('profiles').select('*').eq('id', id).single();
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (!isSuper && target.role !== 'member') return json({ error: 'forbidden' }, 403);
      if (isSuper && target.role === 'super_admin' && target.id !== caller.id) return json({ error: 'forbidden' }, 403);
      const updates: Record<string, unknown> = {};
      if (full_name) updates.full_name = full_name;
      if (phone !== undefined) {
        if (!validPhone(phone)) return json({ error: 'invalid_phone' }, 400);
        const { error: uErr3 } = await admin.auth.admin.updateUserById(id, { phone, phone_confirm: true });
        if (uErr3) return json({ error: uErr3.message }, 400);
        updates.phone = phone;
      }
      if (email !== undefined) {
        if (!validEmail(email)) return json({ error: 'invalid_email' }, 400);
        const { error: uErr4 } = await admin.auth.admin.updateUserById(id, { email, email_confirm: true });
        if (uErr4) return json({ error: uErr4.message }, 400);
        updates.email = email;
      }
      if (Object.keys(updates).length === 0) return json({ error: 'invalid_input' }, 400);
      const { error: pErr } = await admin.from('profiles').update(updates).eq('id', id);
      if (pErr) return json({ error: pErr.message }, 400);
      await log('update_profile', 'profile', id, updates);
      return json({ ok: true });
    }

    // ---------- set status: suspend / reactivate / exclude / restore ----------
    if (action === 'set_status') {
      const { id, status, note } = body;
      if (!id || !['active', 'suspended', 'excluded'].includes(status)) return json({ error: 'invalid_input' }, 400);
      const { data: target } = await admin.from('profiles').select('*').eq('id', id).single();
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (target.id === caller.id) return json({ error: 'cannot_change_self' }, 400);
      if (!isSuper && target.role !== 'member') return json({ error: 'forbidden' }, 403);
      if (isSuper && target.role === 'super_admin') return json({ error: 'forbidden' }, 403);
      const { error: pErr } = await admin.from('profiles').update({ status }).eq('id', id);
      if (pErr) return json({ error: pErr.message }, 400);
      await admin.from('member_status_history').insert({
        member_id: id, status, changed_by: caller.id, note: note || null,
      });
      await log('set_status', 'profile', id, { status });
      return json({ ok: true });
    }

    // ---------- permanent deletion (super admin only) ----------
    if (action === 'delete_user') {
      if (!isSuper) return json({ error: 'forbidden' }, 403);
      const { id } = body;
      if (!id || id === caller.id) return json({ error: 'invalid_input' }, 400);
      const { data: target } = await admin.from('profiles').select('*').eq('id', id).single();
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (target.role === 'super_admin') return json({ error: 'forbidden' }, 403);
      await log('delete_user', 'profile', id, { role: target.role, full_name: target.full_name });
      const { error: dErr } = await admin.auth.admin.deleteUser(id);
      if (dErr) return json({ error: dErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
