-- REVIEW ONLY. After 0018; baseline 5e4933bb21fd8b14fa37b0d844675975164ef68b. No hosted/schema approval.
-- Three nullable JSONB columns and bounded envelope CHECKs only. No default/backfill.
ALTER TABLE "appointments" ADD COLUMN "scheduling_reservation" jsonb;
ALTER TABLE "org_settings" ADD COLUMN "scheduling_policy" jsonb;
ALTER TABLE "projects" ADD COLUMN "scheduling_reservation" jsonb;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_scheduling_reservation_ck" CHECK ("appointments"."scheduling_reservation" is null or coalesce((
      jsonb_typeof("appointments"."scheduling_reservation") = 'object'
      and "appointments"."scheduling_reservation"->'formatVersion' = '1'::jsonb
      and case when jsonb_typeof("appointments"."scheduling_reservation"->'reservationRevision') = 'number' then
        ("appointments"."scheduling_reservation"->>'reservationRevision')::numeric between 1 and 9007199254740991
        and trunc(("appointments"."scheduling_reservation"->>'reservationRevision')::numeric) = ("appointments"."scheduling_reservation"->>'reservationRevision')::numeric else false end
      and case when jsonb_typeof("appointments"."scheduling_reservation"->'sourcePolicyRevision') = 'number' then
        ("appointments"."scheduling_reservation"->>'sourcePolicyRevision')::numeric between 1 and 9007199254740991
        and trunc(("appointments"."scheduling_reservation"->>'sourcePolicyRevision')::numeric) = ("appointments"."scheduling_reservation"->>'sourcePolicyRevision')::numeric else false end
      and jsonb_typeof("appointments"."scheduling_reservation"->'sourcePolicyDigest') = 'string'
      and jsonb_typeof("appointments"."scheduling_reservation"->'approvedTimeZone') = 'string'
      and jsonb_typeof("appointments"."scheduling_reservation"->'inspection') in ('null', 'object')
      and jsonb_typeof("appointments"."scheduling_reservation"->'startAt') = 'string'
      and jsonb_typeof("appointments"."scheduling_reservation"->'endAt') = 'string'
      and jsonb_typeof("appointments"."scheduling_reservation"->'resourceUserIds') = 'array'
      and case when jsonb_typeof("appointments"."scheduling_reservation"->'minimumTravelGapMinutes') = 'number' then
        ("appointments"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric between 0 and 1440
        and trunc(("appointments"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric) = ("appointments"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric else false end
      and jsonb_typeof("appointments"."scheduling_reservation"->'duration') = 'object'
      and jsonb_typeof("appointments"."scheduling_reservation"->'admittedAt') = 'string'
      and jsonb_typeof("appointments"."scheduling_reservation"->'admittedByUserId') in ('null', 'string')
      and jsonb_typeof("appointments"."scheduling_reservation"->'target') = 'object'
      and jsonb_typeof("appointments"."scheduling_reservation"->'lastTransition') = 'object'
    ), false));
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_scheduling_policy_ck" CHECK ("org_settings"."scheduling_policy" is null or coalesce((
      jsonb_typeof("org_settings"."scheduling_policy") = 'object'
      and "org_settings"."scheduling_policy"->'formatVersion' = '1'::jsonb
      and case when jsonb_typeof("org_settings"."scheduling_policy"->'revision') = 'number' then
        ("org_settings"."scheduling_policy"->>'revision')::numeric between 1 and 9007199254740991
        and trunc(("org_settings"."scheduling_policy"->>'revision')::numeric) = ("org_settings"."scheduling_policy"->>'revision')::numeric else false end
      and jsonb_typeof("org_settings"."scheduling_policy"->'enabled') = 'boolean'
      and jsonb_typeof("org_settings"."scheduling_policy"->'timeZone') = 'string'
      and case when jsonb_typeof("org_settings"."scheduling_policy"->'minimumTravelGapMinutes') = 'number' then
        ("org_settings"."scheduling_policy"->>'minimumTravelGapMinutes')::numeric between 0 and 1440
        and trunc(("org_settings"."scheduling_policy"->>'minimumTravelGapMinutes')::numeric) = ("org_settings"."scheduling_policy"->>'minimumTravelGapMinutes')::numeric else false end
      and case when jsonb_typeof("org_settings"."scheduling_policy"->'maxConcurrentReservations') = 'null' then true
        when jsonb_typeof("org_settings"."scheduling_policy"->'maxConcurrentReservations') = 'number' then
        ("org_settings"."scheduling_policy"->>'maxConcurrentReservations')::numeric between 1 and 100
        and trunc(("org_settings"."scheduling_policy"->>'maxConcurrentReservations')::numeric) = ("org_settings"."scheduling_policy"->>'maxConcurrentReservations')::numeric else false end
      and case when jsonb_typeof("org_settings"."scheduling_policy"->'durationPresets') = 'array' then
        jsonb_array_length("org_settings"."scheduling_policy"->'durationPresets') <= 50
        and jsonb_array_length(jsonb_path_query_array("org_settings"."scheduling_policy"->'durationPresets', 'strict $[*] ? (@.type() == "object" && exists(@.id ? (@.type() == "string")) && exists(@.label ? (@.type() == "string" && @ like_regex "^.{1,80}$" flag "s" && !(@ like_regex "^[[:space:]]*$"))) && exists(@.elapsedMinutes ? (@.type() == "number" && @ >= 1 && @ <= 1440 && @ % 1 == 0)))', '{}'::jsonb, true)) = jsonb_array_length("org_settings"."scheduling_policy"->'durationPresets')
        else false end
      and jsonb_typeof("org_settings"."scheduling_policy"->'digest') = 'string'
      and jsonb_typeof("org_settings"."scheduling_policy"->'updatedAt') = 'string'
      and jsonb_typeof("org_settings"."scheduling_policy"->'updatedByUserId') = 'string'
    ), false));
ALTER TABLE "projects" ADD CONSTRAINT "projects_scheduling_reservation_ck" CHECK ("projects"."scheduling_reservation" is null or coalesce((
      jsonb_typeof("projects"."scheduling_reservation") = 'object'
      and "projects"."scheduling_reservation"->'formatVersion' = '1'::jsonb
      and case when jsonb_typeof("projects"."scheduling_reservation"->'reservationRevision') = 'number' then
        ("projects"."scheduling_reservation"->>'reservationRevision')::numeric between 1 and 9007199254740991
        and trunc(("projects"."scheduling_reservation"->>'reservationRevision')::numeric) = ("projects"."scheduling_reservation"->>'reservationRevision')::numeric else false end
      and case when jsonb_typeof("projects"."scheduling_reservation"->'sourcePolicyRevision') = 'number' then
        ("projects"."scheduling_reservation"->>'sourcePolicyRevision')::numeric between 1 and 9007199254740991
        and trunc(("projects"."scheduling_reservation"->>'sourcePolicyRevision')::numeric) = ("projects"."scheduling_reservation"->>'sourcePolicyRevision')::numeric else false end
      and jsonb_typeof("projects"."scheduling_reservation"->'sourcePolicyDigest') = 'string'
      and jsonb_typeof("projects"."scheduling_reservation"->'approvedTimeZone') = 'string'
      and jsonb_typeof("projects"."scheduling_reservation"->'inspection') in ('null', 'object')
      and jsonb_typeof("projects"."scheduling_reservation"->'startAt') = 'string'
      and jsonb_typeof("projects"."scheduling_reservation"->'endAt') = 'string'
      and jsonb_typeof("projects"."scheduling_reservation"->'resourceUserIds') = 'array'
      and case when jsonb_typeof("projects"."scheduling_reservation"->'minimumTravelGapMinutes') = 'number' then
        ("projects"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric between 0 and 1440
        and trunc(("projects"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric) = ("projects"."scheduling_reservation"->>'minimumTravelGapMinutes')::numeric else false end
      and jsonb_typeof("projects"."scheduling_reservation"->'duration') = 'object'
      and jsonb_typeof("projects"."scheduling_reservation"->'admittedAt') = 'string'
      and jsonb_typeof("projects"."scheduling_reservation"->'admittedByUserId') in ('null', 'string')
      and jsonb_typeof("projects"."scheduling_reservation"->'target') = 'object'
      and jsonb_typeof("projects"."scheduling_reservation"->'lastTransition') = 'object'
    ), false));
