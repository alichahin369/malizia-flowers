-- Malizia Flowers — database setup (Supabase / Postgres)
-- Orders placed on the website land in `orders`; the owner dashboard reads and updates them.
-- Prices are always recomputed on the server from `products`, so a customer can't change them.

create extension if not exists pgcrypto;

-- Who can open the dashboard (by login email)
create table if not exists public.admins (
  email text primary key
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email','')));
$$;

-- Catalog: prices + availability the dashboard can edit
create table if not exists public.products (
  id text primary key,
  name text not null,
  category text not null,          -- roses | mixed | gifts | plants
  variants jsonb not null,         -- [{"l":"Small","p":100,"from":false}, ...]
  available boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now()
);

-- Orders
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null default 'website',      -- website | whatsapp | instagram | phone | walk-in
  status text not null default 'new'
    check (status in ('new','preparing','ready','out_for_delivery','delivered','cancelled')),
  items jsonb not null,                          -- [{id,vi,q,name,label,price,from}]
  subtotal numeric(10,2) not null default 0,
  delivery_fee numeric(10,2) not null default 0,
  total numeric(10,2) generated always as (subtotal + delivery_fee) stored,
  paid boolean not null default false,
  payment_method text,
  customer_name text,
  customer_phone text,
  recipient_name text,
  recipient_phone text,
  address text,
  delivery_date date,
  delivery_slot text,
  card_message text,
  driver text,
  notes text
);
create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists orders_delivery_idx on public.orders (delivery_date);

-- Server-side pricing + clean-up of anything a website visitor sends
create or replace function public.price_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  it jsonb; out_items jsonb := '[]'::jsonb; prod record; v jsonb; q int; sub numeric := 0;
  admin boolean := public.is_admin();
begin
  for it in select value from jsonb_array_elements(coalesce(new.items,'[]'::jsonb)) loop
    q := least(greatest(coalesce((it->>'q')::int, 1), 1), 50);
    select * into prod from public.products where id = it->>'id';
    if not found or (not prod.available and not admin) then
      if admin and (it ? 'price') then        -- owner can add custom items to manual orders
        out_items := out_items || jsonb_build_array(jsonb_build_object(
          'id', coalesce(it->>'id','custom'), 'q', q, 'name', coalesce(it->>'name','Custom item'),
          'label', coalesce(it->>'label',''), 'price', (it->>'price')::numeric));
        sub := sub + (it->>'price')::numeric * q;
      end if;
      continue;
    end if;
    v := prod.variants -> coalesce((it->>'vi')::int, 0);
    if v is null then continue; end if;
    out_items := out_items || jsonb_build_array(jsonb_build_object(
      'id', prod.id, 'vi', coalesce((it->>'vi')::int,0), 'q', q, 'name', prod.name,
      'label', v->>'l', 'price', (v->>'p')::numeric, 'from', coalesce((v->>'from')::boolean,false)));
    sub := sub + (v->>'p')::numeric * q;
  end loop;
  if jsonb_array_length(out_items) = 0 then
    raise exception 'Order has no available items';
  end if;
  new.items := out_items;
  new.subtotal := sub;
  if not admin then
    new.status := 'new'; new.paid := false; new.delivery_fee := 0; new.source := 'website';
    new.driver := null; new.notes := null; new.payment_method := null;
    new.customer_name := left(new.customer_name, 120);  new.customer_phone := left(new.customer_phone, 40);
    new.recipient_name := left(new.recipient_name, 120); new.recipient_phone := left(new.recipient_phone, 40);
    new.address := left(new.address, 400); new.delivery_slot := left(new.delivery_slot, 60);
    new.card_message := left(new.card_message, 300);
  end if;
  return new;
end $$;

drop trigger if exists orders_price on public.orders;
create trigger orders_price before insert on public.orders
  for each row execute function public.price_order();

create or replace function public.touch_updated() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated();
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products for each row execute function public.touch_updated();

-- Security rules
alter table public.admins   enable row level security;
alter table public.products enable row level security;
alter table public.orders   enable row level security;

drop policy if exists "admins see admins" on public.admins;
create policy "admins see admins" on public.admins for select using (public.is_admin());

drop policy if exists "anyone reads products" on public.products;
create policy "anyone reads products" on public.products for select using (true);
drop policy if exists "admins edit products" on public.products;
create policy "admins edit products" on public.products for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "anyone places orders" on public.orders;
create policy "anyone places orders" on public.orders for insert with check (true);
drop policy if exists "admins read orders" on public.orders;
create policy "admins read orders" on public.orders for select using (public.is_admin());
drop policy if exists "admins update orders" on public.orders;
create policy "admins update orders" on public.orders for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete orders" on public.orders;
create policy "admins delete orders" on public.orders for delete using (public.is_admin());

-- Live updates on the dashboard
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;
