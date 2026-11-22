// Midad — manage-users Edge Function
// Privileged account operations only. Service-role credentials remain server-side.
// No external module imports: the function can boot without resolving a CDN/JSR package.
// @ts-nocheck

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
};

const PIN_SUFFIX = 'MD';

function preflightResponse(req: Request) {
  const headers = new Headers(corsHeaders);
  const requestedHeaders = req.headers.get('Access-Control-Request-Headers');
  const requestedMethod = req.headers.get('Access-Control-Request-Method')?.toUpperCase();
  if (requestedHeaders) headers.set('Access-Control-Allow-Headers', requestedHeaders);
  if (requestedMethod === 'GET' || requestedMethod === 'POST') {
    headers.set('Access-Control-Allow-Methods', `${requestedMethod}, OPTIONS`);
  }
  return new Response('ok', { headers });
}

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

async function readApiResponse(response: Response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { message: text }; }
  }
  return { ok: response.ok, status: response.status, data };
}

function apiError(result: { data: any }, fallback: string) {
  const data = result?.data;
  const message = data?.msg || data?.message || data?.error_description || data?.error;
  return typeof message === 'string' ? message : fallback;
}

function serviceAuthorization(key: string): string | null {
  // New Supabase secret API keys are not JWTs and must not be sent as Bearer tokens.
  // Legacy service_role keys are JWTs, so they remain valid Authorization tokens.
  return key.startsWith('sb_secret_') ? null : `Bearer ${key}`;
}

function safeUpstreamReason(status: number) {
  if (status === 401) return 'service_key_rejected';
  if (status === 403) return 'database_permission_denied';
  if (status === 404) return 'rest_endpoint_not_found';
  return 'database_api_error';
}

async function healthCheck() {
  try {
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!supabaseUrl || !serviceKey) return json({ ok: false, stage: 'configuration' }, 503);
    const headers: Record<string, string> = { apikey: serviceKey };
    const authorization = serviceAuthorization(serviceKey);
    if (authorization) headers.Authorization = authorization;
    const response = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id&limit=1`, { headers });
    if (!response.ok) {
      return json({ ok: false, stage: 'profiles_query', status: response.status, reason: safeUpstreamReason(response.status) }, 503);
    }
    await response.body?.cancel();
    return json({ ok: true, service: 'manage-users', database: 'connected' });
  } catch {
    return json({ ok: false, stage: 'database_api', reason: 'upstream_unreachable' }, 503);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflightResponse(req);
  // Safe, read-only probe: reports status only and never returns database rows or secrets.
  if (req.method === 'GET') return await healthCheck();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!supabaseUrl || !serviceKey || !anonKey) throw new Error('server_configuration_missing');

    async function apiRequest(
      path: string,
      apiKey: string,
      authorization: string | null,
      method = 'GET',
      body?: unknown,
      extraHeaders: Record<string, string> = {},
    ) {
      const headers: Record<string, string> = {
        apikey: apiKey,
        ...extraHeaders,
      };
      if (authorization) headers.Authorization = authorization;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${supabaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return await readApiResponse(response);
    }

    function rest(method: string, resource: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
      return apiRequest(
        `/rest/v1/${resource}`,
        serviceKey,
        serviceAuthorization(serviceKey),
        method,
        body,
        extraHeaders,
      );
    }

    function adminAuth(method: string, resource: string, body?: unknown) {
      return apiRequest(
        `/auth/v1/admin/${resource}`,
        serviceKey,
        serviceAuthorization(serviceKey),
        method,
        body,
      );
    }

    async function getProfile(id: string) {
      const query = new URLSearchParams({ id: `eq.${id}`, select: '*', limit: '1' });
      const result = await rest('GET', `profiles?${query.toString()}`);
      return { ...result, profile: Array.isArray(result.data) ? result.data[0] || null : null };
    }

    async function insertActivity(actorId: string, action: string, targetType: string, targetId: string, details: unknown) {
      const result = await rest('POST', 'activity_logs', {
        actor_id: actorId,
        action,
        target_type: targetType,
        target_id: targetId,
        details,
      }, { Prefer: 'return=minimal' });
      if (!result.ok) console.error('[manage-users] activity log insert failed:', result.status);
    }

    async function createAuthUser(body: Record<string, unknown>) {
      const result = await adminAuth('POST', 'users', body);
      if (!result.ok) return { user: null, error: apiError(result, 'create_failed') };
      const user = result.data?.user || result.data;
      return user?.id ? { user, error: null } : { user: null, error: 'create_failed' };
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const minimalHeaders = { Prefer: 'return=minimal' };

    // One-time bootstrap: only allowed while the system has no super administrator.
    if (action === 'bootstrap_super_admin') {
      const query = new URLSearchParams({ role: 'eq.super_admin', select: 'id', limit: '1' });
      const existing = await rest('GET', `profiles?${query.toString()}`);
      if (!existing.ok) {
        console.error('[manage-users] bootstrap profiles query failed:', existing.status, existing.data?.code || '');
        return json({
          error: 'bootstrap_check_failed',
          upstream_status: existing.status,
          reason: safeUpstreamReason(existing.status),
        }, 500);
      }
      if (Array.isArray(existing.data) && existing.data.length > 0) {
        return json({ error: 'bootstrap_disabled' }, 403);
      }

      const { full_name, email, password } = body;
      if (!full_name || !validEmail(email) || typeof password !== 'string' || password.length < 6) {
        return json({ error: 'invalid_input' }, 400);
      }
      const { user, error } = await createAuthUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });
      if (error || !user) return json({ error: error || 'create_failed' }, 400);

      const profile = await rest('POST', 'profiles', {
        id: user.id,
        role: 'super_admin',
        full_name,
        email,
        status: 'active',
      }, minimalHeaders);
      if (!profile.ok) {
        // Avoid leaving an Auth account without its matching profile if DB insert fails.
        await adminAuth('DELETE', `users/${encodeURIComponent(user.id)}`);
        return json({ error: apiError(profile, 'profile_create_failed') }, 400);
      }
      await insertActivity(user.id, 'bootstrap_super_admin', 'profile', user.id, { full_name });
      return json({ ok: true, id: user.id });
    }

    // All non-bootstrap actions require a signed-in active administrator.
    const authHeader = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/i.test(authHeader)) return json({ error: 'unauthorized' }, 401);
    const authUser = await apiRequest('/auth/v1/user', anonKey, authHeader);
    if (!authUser.ok || !authUser.data?.id) return json({ error: 'unauthorized' }, 401);
    const callerResult = await getProfile(authUser.data.id);
    if (!callerResult.ok) return json({ error: 'profile_lookup_failed' }, 500);
    const caller = callerResult.profile;
    if (!caller) return json({ error: 'profile_not_found' }, 403);
    if (caller.role === 'member') return json({ error: 'forbidden' }, 403);
    if (caller.status !== 'active') return json({ error: 'account_not_active' }, 403);
    const isSuper = caller.role === 'super_admin';

    // Create a member and set their 4-digit PIN through Supabase Auth Admin API.
    if (action === 'create_member') {
      const { full_name, phone, pin } = body;
      if (!full_name || !validPhone(phone) || !validPin(pin)) return json({ error: 'invalid_input' }, 400);
      const { user, error } = await createAuthUser({
        phone,
        password: pin + PIN_SUFFIX,
        phone_confirm: true,
        user_metadata: { full_name },
      });
      if (error || !user) return json({ error: error || 'create_failed' }, 400);
      const profile = await rest('POST', 'profiles', {
        id: user.id, role: 'member', full_name, phone, status: 'active',
      }, minimalHeaders);
      if (!profile.ok) {
        await adminAuth('DELETE', `users/${encodeURIComponent(user.id)}`);
        return json({ error: apiError(profile, 'profile_create_failed') }, 400);
      }
      await rest('POST', 'member_status_history', {
        member_id: user.id, status: 'active', changed_by: caller.id, note: 'member_created',
      }, minimalHeaders);
      await insertActivity(caller.id, 'create_member', 'profile', user.id, { full_name, phone });
      return json({ ok: true, id: user.id });
    }

    if (action === 'reset_pin') {
      const { member_id, pin } = body;
      if (!member_id || !validPin(pin)) return json({ error: 'invalid_input' }, 400);
      const targetResult = await getProfile(member_id);
      const target = targetResult.profile;
      if (!target || target.role !== 'member') return json({ error: 'target_not_found' }, 404);
      const updated = await adminAuth('PUT', `users/${encodeURIComponent(member_id)}`, { password: pin + PIN_SUFFIX });
      if (!updated.ok) return json({ error: apiError(updated, 'pin_reset_failed') }, 400);
      await insertActivity(caller.id, 'reset_pin', 'profile', member_id, {});
      return json({ ok: true });
    }

    if (action === 'create_assistant') {
      if (!isSuper) return json({ error: 'forbidden' }, 403);
      const { full_name, email, password } = body;
      if (!full_name || !validEmail(email) || typeof password !== 'string' || password.length < 6) {
        return json({ error: 'invalid_input' }, 400);
      }
      const { user, error } = await createAuthUser({
        email, password, email_confirm: true, user_metadata: { full_name },
      });
      if (error || !user) return json({ error: error || 'create_failed' }, 400);
      const profile = await rest('POST', 'profiles', {
        id: user.id, role: 'assistant_admin', full_name, email, status: 'active',
      }, minimalHeaders);
      if (!profile.ok) {
        await adminAuth('DELETE', `users/${encodeURIComponent(user.id)}`);
        return json({ error: apiError(profile, 'profile_create_failed') }, 400);
      }
      await insertActivity(caller.id, 'create_assistant', 'profile', user.id, { full_name, email });
      return json({ ok: true, id: user.id });
    }

    if (action === 'update_profile') {
      const { id, full_name, phone, email } = body;
      if (!id) return json({ error: 'invalid_input' }, 400);
      const targetResult = await getProfile(id);
      const target = targetResult.profile;
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (!isSuper && target.role !== 'member') return json({ error: 'forbidden' }, 403);
      if (isSuper && target.role === 'super_admin' && target.id !== caller.id) return json({ error: 'forbidden' }, 403);

      const updates: Record<string, unknown> = {};
      if (full_name) updates.full_name = full_name;
      if (phone !== undefined) {
        if (!validPhone(phone)) return json({ error: 'invalid_phone' }, 400);
        const authUpdate = await adminAuth('PUT', `users/${encodeURIComponent(id)}`, { phone, phone_confirm: true });
        if (!authUpdate.ok) return json({ error: apiError(authUpdate, 'phone_update_failed') }, 400);
        updates.phone = phone;
      }
      if (email !== undefined) {
        if (!validEmail(email)) return json({ error: 'invalid_email' }, 400);
        const authUpdate = await adminAuth('PUT', `users/${encodeURIComponent(id)}`, { email, email_confirm: true });
        if (!authUpdate.ok) return json({ error: apiError(authUpdate, 'email_update_failed') }, 400);
        updates.email = email;
      }
      if (Object.keys(updates).length === 0) return json({ error: 'invalid_input' }, 400);
      const query = new URLSearchParams({ id: `eq.${id}` });
      const profileUpdate = await rest('PATCH', `profiles?${query.toString()}`, updates, minimalHeaders);
      if (!profileUpdate.ok) return json({ error: apiError(profileUpdate, 'profile_update_failed') }, 400);
      await insertActivity(caller.id, 'update_profile', 'profile', id, updates);
      return json({ ok: true });
    }

    if (action === 'set_status') {
      const { id, status, note } = body;
      if (!id || !['active', 'suspended'].includes(status)) return json({ error: 'invalid_input' }, 400);
      const targetResult = await getProfile(id);
      const target = targetResult.profile;
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (target.status === 'excluded') return json({ error: 'legacy_account_requires_deletion' }, 409);
      if (target.id === caller.id) return json({ error: 'cannot_change_self' }, 400);
      if (!isSuper && target.role !== 'member') return json({ error: 'forbidden' }, 403);
      if (isSuper && target.role === 'super_admin') return json({ error: 'forbidden' }, 403);
      const query = new URLSearchParams({ id: `eq.${id}` });
      const profileUpdate = await rest('PATCH', `profiles?${query.toString()}`, { status }, minimalHeaders);
      if (!profileUpdate.ok) return json({ error: apiError(profileUpdate, 'status_update_failed') }, 400);
      await rest('POST', 'member_status_history', {
        member_id: id, status, changed_by: caller.id, note: note || null,
      }, minimalHeaders);
      await insertActivity(caller.id, 'set_status', 'profile', id, { status });
      return json({ ok: true });
    }

    if (action === 'delete_user') {
      if (!isSuper) return json({ error: 'forbidden' }, 403);
      const { id } = body;
      if (!id || id === caller.id) return json({ error: 'invalid_input' }, 400);
      const targetResult = await getProfile(id);
      const target = targetResult.profile;
      if (!target) return json({ error: 'target_not_found' }, 404);
      if (target.role === 'super_admin') return json({ error: 'forbidden' }, 403);
      // Deleting the Auth user cascades through profiles and the reading-data
      // foreign keys. A profile DELETE trigger also purges activity rows that
      // identify this account, without recording a new delete event.
      const deleted = await adminAuth('DELETE', `users/${encodeURIComponent(id)}`);
      if (!deleted.ok) return json({ error: apiError(deleted, 'delete_failed') }, 400);
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (error) {
    const message = String(error?.message || error);
    console.error('[manage-users] request failed:', message);
    return json({ error: 'server_error' }, 500);
  }
});
