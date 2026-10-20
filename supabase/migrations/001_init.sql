-- Havas Houttransport dashboard: database, rechten en opslag
-- Draai dit één keer in Supabase → SQL Editor (of via `supabase db push`).

-- ───────────── profielen & rollen ─────────────
-- rol: 'beheerder' ziet alles, 'chauffeur' alleen eigen uren + planning/stamgegevens,
--      'wacht' = nieuw account dat nog door een beheerder goedgekeurd moet worden.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  naam       text,
  rol        text not null default 'wacht' check (rol in ('beheerder','chauffeur','wacht')),
  aangemaakt timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_beheerder() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and rol = 'beheerder');
$$;

create or replace function public.is_lid() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and rol in ('beheerder','chauffeur'));
$$;

-- Nieuw account → profiel. Het allereerste account wordt automatisch beheerder.
create or replace function public.nieuw_profiel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, naam, rol)
  values (
    new.id, new.email,
    coalesce(nullif(new.raw_user_meta_data->>'naam',''), split_part(new.email,'@',1)),
    case when exists (select 1 from public.profiles where rol = 'beheerder') then 'wacht' else 'beheerder' end
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.nieuw_profiel();

drop policy if exists "profiel lezen" on public.profiles;
create policy "profiel lezen" on public.profiles for select
  using (id = auth.uid() or public.is_beheerder());
drop policy if exists "profiel beheren" on public.profiles;
create policy "profiel beheren" on public.profiles for update
  using (public.is_beheerder()) with check (public.is_beheerder());
drop policy if exists "profiel verwijderen" on public.profiles;
create policy "profiel verwijderen" on public.profiles for delete
  using (public.is_beheerder() and id <> auth.uid());

-- eigen naam mag iedereen aanpassen, rol niet
create or replace function public.zet_eigen_naam(nieuwe_naam text) returns void
language sql security definer set search_path = public as $$
  update public.profiles set naam = left(trim(nieuwe_naam), 80) where id = auth.uid();
$$;

-- ───────────── documenten (zelfde padstructuur als het artifact) ─────────────
-- stam/lijsten · ritten/<id> · uren/<sleutel>/weken/<jaar-Wnn> · beheer/... enz.
create table if not exists public.docs (
  path       text primary key check (path ~ '^[^/]+(/[^/]+)*$'),
  parent     text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data       jsonb not null default '{}'::jsonb,
  gewijzigd  timestamptz not null default now(),
  door       uuid default auth.uid()
);
create index if not exists docs_parent_idx on public.docs (parent);
alter table public.docs enable row level security;

-- Is dit pad het eigen deel van de ingelogde chauffeur? (uren/<uid> en alles daaronder)
create or replace function public.eigen_pad(p text) returns boolean
language sql stable as $$
  select auth.uid() is not null and (p = 'uren/' || auth.uid()::text or p like 'uren/' || auth.uid()::text || '/%');
$$;

-- Lezen: beheerder alles; chauffeur alle algemene gegevens (stam, ritten) behalve beheer/ en uren/ van anderen.
drop policy if exists "docs lezen" on public.docs;
create policy "docs lezen" on public.docs for select using (
  public.is_beheerder()
  or (public.is_lid() and path not like 'beheer/%' and path not like 'uren/%' and path <> 'beheer' and path <> 'uren')
  or (public.is_lid() and public.eigen_pad(path))
);
-- Schrijven: beheerder alles; chauffeur alleen het eigen deel.
drop policy if exists "docs toevoegen" on public.docs;
create policy "docs toevoegen" on public.docs for insert with check (
  public.is_beheerder() or (public.is_lid() and public.eigen_pad(path)));
drop policy if exists "docs wijzigen" on public.docs;
create policy "docs wijzigen" on public.docs for update
  using (public.is_beheerder() or (public.is_lid() and public.eigen_pad(path)))
  with check (public.is_beheerder() or (public.is_lid() and public.eigen_pad(path)));
drop policy if exists "docs verwijderen" on public.docs;
create policy "docs verwijderen" on public.docs for delete using (
  public.is_beheerder() or (public.is_lid() and public.eigen_pad(path)));

create or replace function public.docs_stempel() returns trigger language plpgsql as $$
begin new.gewijzigd := now(); new.door := coalesce(auth.uid(), new.door); return new; end $$;
drop trigger if exists docs_stempel on public.docs;
create trigger docs_stempel before insert or update on public.docs
  for each row execute function public.docs_stempel();

-- Bovenste velden samenvoegen (zoals "update" in het artifact); faalt als het document niet bestaat.
create or replace function public.doc_merge(p text, partial jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = data || partial where path = p;
  if not found then raise exception 'doc_bestaat_niet' using errcode = 'P0002'; end if;
end $$;

-- Live bijwerken voor alle open schermen
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ───────────── foto's (bonnen, maandregistraties, tanklijsten) ─────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('fotos', 'fotos', false, 15728640)
on conflict (id) do nothing;

-- Bestandspad: <uid van uploader>/<willekeurige id>.<ext>
drop policy if exists "fotos lezen" on storage.objects;
create policy "fotos lezen" on storage.objects for select using (
  bucket_id = 'fotos' and (public.is_beheerder() or (public.is_lid() and (storage.foldername(name))[1] = auth.uid()::text)));
drop policy if exists "fotos uploaden" on storage.objects;
create policy "fotos uploaden" on storage.objects for insert with check (
  bucket_id = 'fotos' and public.is_lid() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "fotos verwijderen" on storage.objects;
create policy "fotos verwijderen" on storage.objects for delete using (
  bucket_id = 'fotos' and (public.is_beheerder() or (storage.foldername(name))[1] = auth.uid()::text));

-- Back-ups (alleen via de server-functie, beheerders mogen lezen)
insert into storage.buckets (id, name, public) values ('backups', 'backups', false)
on conflict (id) do nothing;
drop policy if exists "backups lezen" on storage.objects;
create policy "backups lezen" on storage.objects for select using (
  bucket_id = 'backups' and public.is_beheerder());
