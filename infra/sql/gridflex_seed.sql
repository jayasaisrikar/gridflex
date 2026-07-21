-- GridFlex canonical demo seed.
-- Run after gridflex_schema.sql.
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
  'Lone Star Compute Facility', 'lone-star-compute', 'America/Chicago',
  'US', 'Texas', 'ERCOT', 1600, 900, 600, 100, 150,
  '{"demo":true,"asset_profile":"AI/HPC and flexible compute"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO flexibility_mechanisms
(id, facility_id, code, name, mechanism_type, declared_reducible_kw, ramp_rate_kw_per_min, maximum_duration_min, rebound_window_min, metadata)
VALUES
('33333333-3333-4333-8333-333333333331','22222222-2222-4222-8222-222222222222','WORKLOAD_DEFERRAL','Batch workload deferral','WORKLOAD',350,80,60,20,'{"provenance":"DECLARED"}'),
('33333333-3333-4333-8333-333333333332','22222222-2222-4222-8222-222222222222','COOLING_HEADROOM','Cooling thermal headroom','COOLING',100,20,30,30,'{"provenance":"DECLARED"}'),
('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','UPS_BESS','UPS/BESS discharge support','STORAGE',150,150,30,45,'{"provenance":"DECLARED"}')
ON CONFLICT (facility_id, code) DO NOTHING;

INSERT INTO facility_constraints
(facility_id, version, minimum_safe_load_kw, maximum_curtailment_kw, maximum_ramp_kw_per_min, maximum_duration_min, minimum_recovery_min, maximum_rebound_kw, thermal_limit_c, source_note)
VALUES
('22222222-2222-4222-8222-222222222222',1,900,600,100,60,30,250,32,'Canonical demo constraints')
ON CONFLICT (facility_id, version) DO NOTHING;

COMMIT;
