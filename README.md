# ThoughtMatters.ai — Realtime WebSocket + Supabase + Vercel

This project uses:
- Pure static HTML/JS for UI
- Vercel Edge Functions for backend
- Supabase auth.users for authentication
- user_profiles table for custom profile fields
- OpenAI Realtime WebSocket API for ultra-fast chat

---

## 1. Create Supabase Table (Required)

Run in Supabase SQL Editor:

```sql
create table public.user_profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    name text,
    phone text,
    status text default 'pending',
    created_at timestamp default now()
);
```

RLS Off for now:

```sql
alter table user_profiles enable row level security;
```

Create open policies:

```sql
create policy "Allow read for authenticated users"
on user_profiles for select
using (auth.uid() = id);

create policy "Allow insert for authenticated users"
on user_profiles for insert
with check (auth.uid() = id);

create policy "Allow update for authenticated users"
on user_profiles for update
using (auth.uid() = id);
```

Admin-only update will use Service Role Key.

---

## 2. Configure Environment Variables on Vercel

Add:

- NEXT_PUBLIC_SUPABASE_URL  
- SUPABASE_SERVICE_ROLE_KEY  
- OPENAI_API_KEY  
- ADMIN_EMAIL  
- ADMIN_PASSWORD  

---

## 3. Deploy to Vercel

```
vercel
```

Or connect GitHub and push.

---

## 4. Connect GoDaddy Domain

In Vercel Project → Settings → Domains → Add Domain

Add:  
`thoughtmatters.in`

Then GoDaddy DNS:

```
A     @      76.76.21.21
CNAME www    cname.vercel-dns.com
```

Propagate 5–15 min.

---

## 5. Start Realtime Chat

Frontend loads `/frontend/js/app.js`  
This calls:

- `/api/chat/token` → to generate WebSocket session  
- Connects directly to OpenAI Realtime API via WebSocket  

---

## 6. Admin Panel

Admin login:
- Uses email/password stored in .env  
- List users from `auth.users`  
- Join user_profiles  
- Approve user by updating status → "approved"

---

## Project Structure

```
project-root/
    frontend/
    api/
    package.json
    vercel.json
    .env.local
```
