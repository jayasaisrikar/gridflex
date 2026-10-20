-- GridFlex canonical demo seed — UAE profile.
-- Run after gridflex_schema.sql.
--
-- Dubai 10 MW data centre on the DEWA network: the Championship demo facility.
-- The 12pm–5pm summer peak window and grid signals live in
-- packages/forecast/src/signals (fixture), not here — this file holds only
-- the facility's own configuration.
BEGIN;

INSERT INTO organizations (id, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'GridFlex Demo', 'gridflex-demo')
ON CONFLICT (id) DO NOTHING;

-- Create the first user through the API/CLI so the password is Argon2-hashed.

INSERT INTO facilities (
  id, organization_id, name, slug, timezone, country_code, region, market,
  normal_load_kw, minimum_safe_load_kw, maximum_curtailment_kw,
  ramp_rate_kw_per_min, cooling_reserve_kw, metadata
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'Dubai Compute Campus', 'dubai-compute-campus', 'Asia/Dubai',
  'AE', 'Dubai', 'DEWA', 10000, 6000, 3500, 800, 2500,
  '{"demo":true,"asset_profile":"AI/HPC and flexible compute","currency":"AED"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Cooling is the largest flexible load in a Dubai facility, so thermal
-- mechanisms carry the biggest declared caps; the agent draws them first
-- under the COOLING_FIRST plan priority.
INSERT INTO flexibility_mechanisms
(id, facility_id, code, name, mechanism_type, declared_reducible_kw, ramp_rate_kw_per_min, maximum_duration_min, rebound_window_min, metadata)
VALUES
('33333333-3333-4333-8333-333333333331','22222222-2222-4222-8222-222222222222','COOLING_PRECOOL','Chilled-water pre-cooling (thermal bank)','COOLING',1200,300,90,60,'{"provenance":"DECLARED","precoolLeadMinutes":90}'),
('33333333-3333-4333-8333-333333333332','22222222-2222-4222-8222-222222222222','COOLING_SETPOINT_SHIFT','Cooling setpoint shift','COOLING',800,100,240,30,'{"provenance":"DECLARED"}'),
('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','UPS_BESS','UPS/BESS discharge support','STORAGE',1000,1000,30,45,'{"provenance":"DECLARED"}'),
('33333333-3333-4333-8333-333333333334','22222222-2222-4222-8222-222222222222','WORKLOAD_DEFERRAL','Batch workload deferral','WORKLOAD',500,200,120,20,'{"provenance":"DECLARED"}')
ON CONFLICT (facility_id, code) DO NOTHING;

INSERT INTO facility_constraints
(facility_id, version, minimum_safe_load_kw, maximum_curtailment_kw, maximum_ramp_kw_per_min, maximum_duration_min, minimum_recovery_min, maximum_rebound_kw, thermal_limit_c, source_note)
VALUES
('22222222-2222-4222-8222-222222222222',1,6000,3500,800,240,30,1200,30,'Dubai demo constraints (DEWA summer profile)')
ON CONFLICT (facility_id, version) DO NOTHING;

COMMIT;
