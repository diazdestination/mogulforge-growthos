# Contractor eval research notes — 2026-10-11

These notes record the public sources behind the synthetic roofing and HVAC
cases. They are paraphrased summaries for labeling context. They are not
inspection standards, repair instructions or coverage rules. Many sources are
secondary, such as inspector-association, adjuster-forum or contractor pages,
and some take a carrier or policyholder position. Final determinations belong to
qualified contractors, adjusters or engineers.

Company workflow sources (private, not reproduced here):

- `C:\Forge\CSS_OWNER_INTAKE_2026-10-09.md` covers the HVAC owner interview:
  urgent triage examples, diagnostic and maintenance durations, technician
  notes, photos and assessment reports, office review of multi-repair invoices,
  AI-written part descriptions that must not invent work, warranty-validity
  dates on invoices, 6-month residential and quarterly commercial maintenance,
  and 3 estimate reminders 24 hours apart followed by a phone call.
- `painless-smart-site-audit-20261005/design/service-content-sources.md` covers
  the roofing company's product lines and its stance of making no assumed
  warranty terms.
- `reports/contractor-workday-research-2026-10-06.md` and
  `HOUSECALL-PRO-REPLACEMENT-GATE.md` (acceptance cards).
- Two owner-supplied real invoices, redacted on 2026-10-11 and used as
  document-extraction cases.

## Hail damage on asphalt shingles (`research-notes#hail-test-squares`)

- Inspectors commonly lay out a 10 ft x 10 ft test square on each slope. They
  place it in the most-exposed, unsheltered area and count only hits that meet
  a functional-damage definition, such as a fractured mat or displaced granules
  exposing asphalt. The replacement threshold varies by carrier. Adjuster
  discussions cite about 8 per square, and others cite 7–12. It is not a
  universal rule.
  - [InterNACHI — Mastering Roof Inspections: Hail Damage](https://www.nachi.org/hail-damage-part12-39.htm)
  - [CatAdjuster — Protocol for Assessment of Hail-Damaged Roofing](https://catadjuster.org/Home/News/TabId/56/ArtMID/5349/ArticleID/13443/Protocol-for-Assessment-of-Hail-Damaged-Roofing.aspx)
  - [IIBEC paper (Petty & Kasberg, 2009)](https://iibec.org/wp-content/uploads/2009-05-Petty-Kasberg.pdf)
- Dents in soft metals (vents, gutters, downspouts) indicate hail presence and
  roughly bound stone size. The cited research reports dents up to about half
  the stone's diameter. Soft-metal dents alone do not establish functional
  shingle damage.
  - [IIBEC paper (Petty & Kasberg, 2009)](https://iibec.org/wp-content/uploads/2009-05-Petty-Kasberg.pdf)
- Whether surface bruising alone counts is disputed between sources.

## Hail vs. blistering, mechanical and foot-traffic damage (`research-notes#hail-vs-mechanical-damage`, `#hail-vs-blistering`)

- Hail impacts are random, may favor storm-facing slopes, and are absent under
  shelter. Foot-traffic or mechanical marks follow access paths, such as ladder
  to dish or vent and ridge lines. They show scuffs and crushed granules, and
  may show a footprint shape.
- Blisters come from moisture trapped during manufacture. They tend to have
  clean edges, appear uniformly (including sheltered areas), and are a product
  or maintenance issue, not a storm loss. Over-counting blisters as hits
  inflates damage counts.
  - [InspectAPedia — hail damage vs. blister rash](https://inspectapedia.com/roof/Roof_Hail_Damage_vs_Blister_Rash.php)
  - [InspectAPedia — storm/hail damage identification](https://inspectapedia.com/roof/Roof_Hail_Damage_Identification.php)
  - [IBHS — Is it hail damage?](https://ibhs.org/is-it-hail-damage/)
  - [InterNACHI — 3-tab asphalt shingle inspection guide](https://www.nachi.org/school/internachi-university/florida-house-of-horrors/guide/3-tab-asphalt-shingle-roof-inspection-guide/)
  - [Claims Pages — damage or just age](https://www.claimspages.com/editorials/damage-or-just-age/)

## Wind: creased, torn or missing tabs vs. unsealed tabs (`research-notes#wind-creases-vs-unsealed`)

- Carrier-engineering sources hold that wind damage leaves physical
  deformation: creases, tears or missing pieces. Unsealed tabs without that
  deformation are not by themselves wind damage. Unsealing in a diagonal
  stair-step pattern follows installation or thermal causes. Policyholder-side
  commentary notes that the fold line can hide under the overlying course, so
  inspectors should check under the tab.
  - [IIBEC — Misconceptions of wind damage to asphalt composition shingles](https://iibec.org/misconceptions-of-wind-damage-to-asphalt-composition-shingles/)
  - [IIBEC paper (Lopez, Goode, Morrison, 2018)](https://iibec.org/wp-content/uploads/2018.01-Lopez-Goode-Morrison.pdf)
  - [Property Insurance Coverage Law — critique of the seal-strip position](https://www.propertyinsurancecoveragelaw.com/wp-content/uploads/2025/08/HAAGs-violated-seal-strips-are-not-wind-damage-unless-the-shingle-is-creased-torn-or-missing.pdf)
  - [Southern Loss — evaluating wind damage](https://southernloss.com/?p=1698)
- Station wind data describes the station, not the property.
- The research did not cover nail pops.

## HVAC diagnostics (`research-notes#superheat-subcooling`, `#capacitor-tolerance`, `#flame-sensor`, `#heat-exchanger`)

- Superheat and subcooling are the primary charge diagnostics. A TXV system is
  usually judged on subcooling and a fixed orifice on superheat, against OEM
  charts. High superheat with low subcooling suggests undercharge. Airflow and
  filter must be verified first, because readings taken right after startup or
  with restricted airflow mislead.
  - [Cole-Parmer — troubleshooting with superheat and subcooling](https://www.coleparmer.com.cn/tech-article/troubleshooting-hvac-r-systems)
  - [Exam-prep guide — refrigeration and combustion diagnostics](https://open-exam-prep.com/study-guides/ca-hvac-contractor/troubleshooting-repair-maintenance/refrigeration-combustion-diagnostics)
- Run capacitors are rated with a tolerance, commonly ±5–10% (±6% in one of
  the cases). A reading outside the label tolerance in either direction is a
  finding.
  - [HVAC capacitor tolerance explained](https://hvacprosales.com/es-419/blog/hvac-capacitor-tolerance-explained-what-the-numbers-mean/)
- Flame sensors on electronic ignition report a microamp-scale signal. An
  oxidized sensor can cause flame-failure lockout even with a visible flame.
- Condensate overflow float switches open the low-voltage control circuit
  when a clogged drain backs water into the pan, so a cooling shutdown can be
  the first symptom. Sources warn against bypassing the switch.
  - [Rectorseal Safe-T-Switch product description](https://www.supplyhouse.com/Rectorseal-83412-All-Access-Overflow-Shut-Off-Float-Switch)
  - [Champion — what an AC float switch does](https://www.championair.com/blog/what-does-ac-float-switch-do-4)
- Heat exchanger findings are safety-sensitive and sometimes disputed.
  Documentation should record imaging (camera or borescope), CO readings in
  supply air, and flame behavior when the blower starts. A second opinion is
  common before replacement.
  - [Technical Safety BC — cracked heat exchanger incident](https://www.technicalsafetybc.ca/regulatory-resources/incident-investigations/cracked-heat-exchanger-residential-furnace-results-carbon-monoxide-exposure)
  - [Ferguson — furnace heat exchanger diagnostics](https://www.ferguson.com/content/ideas-and-learning-center/trade-talk/furnace-heat-exchanger-diagnostics/)
  - [CTV — second opinions after red-tagged furnaces](https://www.ctvnews.ca/ottawa/article/homeowners-get-second-opinion-after-furnaces-red-tagged-in-winter/)
- General maintenance categories are in the
  [ENERGY STAR maintenance checklist](https://www.energystar.gov/saveathome/heating-cooling/maintenance-checklist),
  cited in the workday research.

## Not used

The research did not use the following:

- licensed standards text;
- carrier manuals;
- paid Haag course material;
- any source that would require reproducing copyrighted text.

The cases contain original wording only.
