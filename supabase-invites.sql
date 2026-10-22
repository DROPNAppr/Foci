-- Run this whole file once in the Supabase SQL editor.

-- ── tables ──────────────────────────────────────────────────────────────

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  type text,
  start date,
  "end" date,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  role text not null default 'Member',
  status text not null default 'pending' check (status in ('pending','accepted')),
  token uuid not null default gen_random_uuid() unique,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- ── helper: is the current user an accepted member (or owner) of a project ─

create or replace function public.is_project_participant(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects pr where pr.id = p_project_id and pr.owner_id = auth.uid()
  ) or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id and pm.user_id = auth.uid() and pm.status = 'accepted'
  );
$$;

-- ── projects RLS ────────────────────────────────────────────────────────

create policy "projects select: owner or accepted member"
on public.projects for select
to authenticated
using (owner_id = auth.uid() or public.is_project_participant(id));

create policy "projects insert: as self"
on public.projects for insert
to authenticated
with check (owner_id = auth.uid());

create policy "projects update: owner or accepted member"
on public.projects for update
to authenticated
using (owner_id = auth.uid() or public.is_project_participant(id))
with check (owner_id = auth.uid() or public.is_project_participant(id));

create policy "projects delete: owner only"
on public.projects for delete
to authenticated
using (owner_id = auth.uid());

-- ── project_members RLS ─────────────────────────────────────────────────

create policy "project_members select: owner or fellow accepted member"
on public.project_members for select
to authenticated
using (public.is_project_participant(project_id));

create policy "project_members insert: owner or accepted member"
on public.project_members for insert
to authenticated
with check (public.is_project_participant(project_id));

create policy "project_members update: owner only"
on public.project_members for update
to authenticated
using (exists (select 1 from public.projects pr where pr.id = project_id and pr.owner_id = auth.uid()));

create policy "project_members delete: owner only"
on public.project_members for delete
to authenticated
using (exists (select 1 from public.projects pr where pr.id = project_id and pr.owner_id = auth.uid()));

-- ── invite lookup + acceptance (bypass RLS deliberately, scoped by token) ─

create or replace function public.get_invite(p_token uuid)
returns table(project_title text, inviter_email text, invitee_email text, status text)
language sql security definer set search_path = public as $$
  select pr.title, u.email, pm.email, pm.status
  from public.project_members pm
  join public.projects pr on pr.id = pm.project_id
  left join auth.users u on u.id = pr.owner_id
  where pm.token = p_token
  limit 1;
$$;
grant execute on function public.get_invite(uuid) to anon, authenticated;

create or replace function public.accept_invite(p_token uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_project_id uuid;
begin
  update public.project_members
  set user_id = auth.uid(), status = 'accepted', accepted_at = now()
  where token = p_token
  returning project_id into v_project_id;

  if v_project_id is null then
    raise exception 'Invalid invite token';
  end if;

  return v_project_id;
end;
$$;
grant execute on function public.accept_invite(uuid) to authenticated;
