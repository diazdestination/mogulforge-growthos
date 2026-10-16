# Reports evidence index

Large raw evidence that used to live under `reports/` has been moved out of the Git tree to keep the repository small. Every archived file is byte-identical to the committed Git blob and is stored at `C:\Forge\artifacts\growthos-evidence-archive\<original path>` on the WILLOWFORGE machine. Git history still contains every file (no history was rewritten); `git show 02306ef:<path>` restores any of them.

The machine-readable list is `reports/evidence-index.json` (path, SHA-256 of the blob bytes, size, line count, git blob id, last modifying commit, last containing commit, archive location).

## Policy

Raw evidence (json/jsonl/txt/log/png/zip) of at least 10240 bytes under reports/. Files referenced by code, tests, scripts or CI (directly, via a dynamic path pattern, or transitively via a referenced manifest) are kept in the tree. Markdown receipts, code and smaller files are untouched.

## Totals

- Archived (removed from tree): 67 files, 59,128,164 bytes, 1,883,754 lines
- Kept (referenced by code/tests/scripts): 16 files, 16,617,239 bytes, 330,467 lines
- Last commit containing the archived files: `02306ef8654ae00fcc4c13a3f0fe24248aa415d6`

## Kept in tree (referenced)

| Path | Bytes | SHA-256 | Referenced by |
|---|---:|---|---|
| `reports/authenticated-driver-2026-10-12/8baf71b8-1e59-410a-9291-e9f955eae32f/oracle.json` | 5673298 | `71b405a32de16dfe8f5c6148b94f3393d599141412eab477a9831c87a042defc` | scripts/production75-operator-test-support.mjs |
| `reports/c1-source-preservation-2026-10-16.json` | 22979 | `6d64fb78992d82fae67eb6d258cf3fbf1e8ea23b4ca11929d9b95b985679348c` | scripts/c1-source-preservation.mjs; scripts/contractor-recovery-drill.mjs; scripts/contractor-recovery-drill.test.mjs |
| `reports/production75-recovery-2026-10-11/catalog142-fly-db.json` | 1129147 | `9076f66aa0a68121864fee8bf8c762c8b6fbb6562e47b6fb8c97301dbc9c5b52` | scripts/production75-observer.test.mjs; scripts/production75-operator.test.mjs; dynamic: scripts/production75-scheduling0019-test-support.mjs (catalog142-${variant}.json) |
| `reports/production75-recovery-2026-10-11/catalog142-growthos_staging.json` | 1129147 | `fa70b68b23ca0ec73372af485dae239554b5f53f34d01311a008c0d707325c5d` | scripts/production75-observer.test.mjs; dynamic: scripts/production75-scheduling0019-test-support.mjs (catalog142-${variant}.json) |
| `reports/production75-recovery-2026-10-11/catalog75-fly-db.json` | 448439 | `f99cbbb80046e2d7c00eab96accd1398d95adc2996568eb972155480fc91521d` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); scripts/production75-combined-manifest.test.mjs; scripts/production75-live-local.mjs |
| `reports/production75-recovery-2026-10-11/catalog75-growthos_staging.json` | 448439 | `6d99e867117e3cef41083beea61161042ae38700eda878596ed0ff901b4391b9` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); scripts/production75-combined-manifest.test.mjs; scripts/production75-legacy-local.mjs |
| `reports/production75-recovery-2026-10-11/fixture75-fly-db.sql` | 87045 | `38b3e851aaf923b02f4c2d615d6d2fc815458cbd56f6cb14e361484f30174ae6` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); dynamic: scripts/production75-legacy-local.mjs, production75-live-local.mjs, production75-operator-local.mjs (fixture75-${variant}.sql) |
| `reports/production75-recovery-2026-10-11/fixture75-growthos_staging.sql` | 87045 | `fb0ffb4144044f9f4d0e8cf6e35403695bd795b8aaeb4f5dcf88ae5aa556d979` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); dynamic: scripts/production75-legacy-local.mjs, production75-live-local.mjs, production75-operator-local.mjs (fixture75-${variant}.sql) |
| `reports/production75-recovery-2026-10-11/local-policy-fly-db.json` | 1838615 | `449a77de61be874e40ba4381fae5e0a268acabd860d6192e8f29fc230df8fb19` | scripts/production75-combined-manifest.test.mjs; dynamic: scripts/production75-core.test.mjs, production75-scheduling0019-test-support.mjs (local-policy-${variant}.json) |
| `reports/production75-recovery-2026-10-11/local-policy-growthos_staging.json` | 1838615 | `efbe3383390588696cbb27a2b41a49b5f72e31b66825bbaa801651b601537072` | dynamic: scripts/production75-core.test.mjs, production75-scheduling0019-test-support.mjs (local-policy-${variant}.json) |
| `reports/release-preparation-2026-10-09/schema-catalog.mjs` | 8282 | `1c05f960796b8db64a4bd45eda43825767695f43d265d70a21f2473c0407a517` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); scripts/production75-core.mjs; scripts/production75-core.test.mjs |
| `reports/release-preparation-2026-10-09/source-manifest.json` | 36811 | `bae0480809fbec16bc66e623c47c0a1fcc07b13d2821af2c689ee1d46559c066` | scripts/production75-core.test.mjs; scripts/staging-copy-rehearsal.mjs; scripts/staging-migration-core.test.mjs |
| `reports/staging-observation-2026-10-10/fixtures/catalog-141.json` | 1538372 | `495c5fd3e2f2328cbf2992f070e8b3cee4c0b81789b355551902dd88b4ee5607` | dynamic: scripts/staging-observation-runner.mjs, staging-observation-local.mjs (catalog-${n}.json) |
| `reports/staging-observation-2026-10-10/fixtures/catalog-142.json` | 1547104 | `8e71df2329e6578972a0902971f355296a0c5174b2103db0070703524959315f` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); scripts/production75-combined-manifest.test.mjs; scripts/production75-legacy-local.mjs |
| `reports/staging-observation-2026-10-10/fixtures/catalog-95.json` | 775775 | `75b75ec030cf2f1decbc183e9d92596e6cc5a213d52dc638c282cb8d826b13c6` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); scripts/production75-combined-manifest.test.mjs; scripts/production75-legacy-local.mjs |
| `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql` | 8126 | `76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9` | scripts/v2-migration (package A, dcbee29 on agent/claude-v2-migration-20261016); artifacts/api-server/src/services/scheduling-schema.test.ts; scripts/production75-custody.mjs |

## Archived

| Path | Bytes | Lines | SHA-256 | Last modified by |
|---|---:|---:|---|---|
| `reports/authenticated-driver-2026-10-12/0710e52a-8a37-45f4-b66b-340926eea73e/native-result.json` | 18300 | 472 | `fe7cdf528de27b12a338007701bcc968c713f23196a72b05fd2cbd8447b5915c` | `8e5ede74ec` |
| `reports/authenticated-driver-2026-10-12/0710e52a-8a37-45f4-b66b-340926eea73e/oracle.json` | 5673298 | 190836 | `030b9ed8204183deb251d7dc5648bfabedbc6cea729736a057197b398fbdd2c5` | `8e5ede74ec` |
| `reports/authenticated-driver-2026-10-12/37bf8d36-9b0a-40fb-9a4d-887ddfda3d2b/native-result.json` | 18300 | 472 | `58d8f9f60a34cfd60e3283191109774eb2ad41d86dbb98a70115176527aecf98` | `795da45c3b` |
| `reports/authenticated-driver-2026-10-12/37bf8d36-9b0a-40fb-9a4d-887ddfda3d2b/oracle.json` | 5673298 | 190836 | `0b10c0b31a0225f4b5b19bdc7cdd7ad77e5ac25e4081bf311cadf60b0d353136` | `795da45c3b` |
| `reports/authenticated-driver-2026-10-12/41603660-3293-4d54-a59d-1523352a8aca/native-result.json` | 18300 | 472 | `e5107d09a071a7d9b2faedaf6ca0a73d5a1a7b2d159db2b0545bcb13f764ed5f` | `bde683c634` |
| `reports/authenticated-driver-2026-10-12/41603660-3293-4d54-a59d-1523352a8aca/oracle.json` | 5673298 | 190836 | `0754e77947ab3f919c7400970403ac1cec41fc5fe2212bd255dd6eb8c5246f0f` | `bde683c634` |
| `reports/authenticated-driver-2026-10-12/71edbbc6-b0b4-41ca-bbf5-7f7d48c37a10/native-result.json` | 18300 | 472 | `d7cdc61ff978f7375fb870b218f7cca6e47a604467158921c6a3c201dfb57424` | `ae2e2eb066` |
| `reports/authenticated-driver-2026-10-12/71edbbc6-b0b4-41ca-bbf5-7f7d48c37a10/oracle.json` | 5673298 | 190836 | `44228156d11323dbea6f3ba58338df88a3bd45788c2c35dcb52125f320af1c9d` | `ae2e2eb066` |
| `reports/authenticated-driver-2026-10-12/8baf71b8-1e59-410a-9291-e9f955eae32f/native-result.json` | 18300 | 472 | `a9c2d6bdf360ff86fc9b41cdbd525ac113a66b2dc21a360dda5f7377439bf506` | `44a0e7421a` |
| `reports/authenticated-driver-2026-10-12/a0ce40b0-f960-40db-a7ac-fedeb1296f98/native-result.json` | 18300 | 472 | `b06c393dffdff6af25f0d1817deecdc2693deb94b6be919ce48359e87393c66e` | `1498d9769d` |
| `reports/authenticated-driver-2026-10-12/a0ce40b0-f960-40db-a7ac-fedeb1296f98/oracle.json` | 5673298 | 190836 | `6a9d9c0545e4543814167e6353551dd7a174bcf5fd121e3b5537fa20fb28059b` | `1498d9769d` |
| `reports/authenticated-driver-2026-10-12/a4e643b3-dbec-4fbb-8363-3c9a941df060/native-result.json` | 18300 | 472 | `78f073c07d3b3fc2e00ba97282a7080b3cb75ac5a10923940c84191012c2627b` | `3868eb4185` |
| `reports/authenticated-driver-2026-10-12/a4e643b3-dbec-4fbb-8363-3c9a941df060/oracle.json` | 5673298 | 190836 | `3d5e32dd686812d4c66f75b33fcef9b80b3e6aa825969349d26e7895c983938b` | `3868eb4185` |
| `reports/authenticated-driver-2026-10-12/b6a81cf8-ab66-4bcb-bed2-865d69f9af86/native-result.json` | 18300 | 472 | `bfe281b6a278d749df7e07d45fe94226311a3d82694988bea7bff41673eaba9e` | `dc2928de39` |
| `reports/authenticated-driver-2026-10-12/b6a81cf8-ab66-4bcb-bed2-865d69f9af86/oracle.json` | 5669698 | 190707 | `d8aa618789dc59bf10a0ac4150f09e5d0d3e0ac1d1501f8f8c8934729ac115bf` | `dc2928de39` |
| `reports/authenticated-driver-2026-10-12/e06dab79-6eb3-480f-bcfe-316d0b5fab34/native-result.json` | 18300 | 472 | `203f3f8e4ee7cb048257ed5fc64b2729aa43a15fd4a33863f5ed07622715c4b2` | `689f5fdcb3` |
| `reports/authenticated-driver-2026-10-12/e06dab79-6eb3-480f-bcfe-316d0b5fab34/oracle.json` | 5673298 | 190836 | `9e206cb0aa028869ee235e568178aee76a91189f4b1cf2bf4dda56ec25c5123a` | `689f5fdcb3` |
| `reports/authenticated-driver-2026-10-12/e9eb4e01-6138-45c0-8c32-7ef9cc0422fd/native-result.json` | 18300 | 472 | `d9a5e679001c519b5409673a5a42db0521611167d19fc9d2f11e04f2befb220b` | `625d255e88` |
| `reports/authenticated-driver-2026-10-12/e9eb4e01-6138-45c0-8c32-7ef9cc0422fd/oracle.json` | 5673298 | 190836 | `2955a730783d14d1c26db9f72489ae82011bb80000fc1d22c1de7d840a7b6fdf` | `625d255e88` |
| `reports/bounded-operator-2026-10-12/dff76c58-6b33-4b2a-b575-111ee62a5271/native-result.json` | 10266 | 274 | `ca7b0cacbb86c65f6881b29279ae1450ad0032cafd9ef6e341bcdb85ee72b35e` | `9541bc1797` |
| `reports/bounded-operator-2026-10-12/dff76c58-6b33-4b2a-b575-111ee62a5271/operator-07df46173c0cf3fb33485d6ecc74644641654c8c9474fb4eb93804cb54953b22/audit.jsonl` | 35644 | 102 | `dfbbe30a1aa3608ac8a1158aa698fc9e0ed8ec2465d5f1185531bbbe0f164a79` | `9541bc1797` |
| `reports/bounded-operator-2026-10-12/dff76c58-6b33-4b2a-b575-111ee62a5271/operator-f00020b92c31672fd23732a250da98c2ce406056d25c70c0ef3b072251434c1f/audit.jsonl` | 35876 | 103 | `cb1edddbb1f0e33a9b90fad938959a87c4eedd86b967a824441e3c60dffd9869` | `9541bc1797` |
| `reports/integrated-running-browser-2026-10-10.desktop.png` | 132428 | 0 | `d9a19682b8489d0391e489b7ed383001a2422b8ffe718d218260a682634559ba` | `1ae1a0376e` |
| `reports/integrated-running-browser-2026-10-10.mobile.png` | 65596 | 0 | `3b6b9934ee7c67904b67f1061d60102a87760f1823023a7f8eed79f27c5781df` | `1ae1a0376e` |
| `reports/integration-validation-2026-10-09/docker-parity.txt` | 14554 | 265 | `5901181ef72a7d71a80310e13a5259b59b622f206a2ffe43b573d6c1bd9bb815` | `d7e38305e4` |
| `reports/integration-validation-2026-10-09/full-api-pg16-attempt1-global-hold.txt` | 125115 | 2018 | `6bd6891408f0b880fbc0cdb3707007bb44cdf220a1da326ffa8c82edfacb3508` | `d7e38305e4` |
| `reports/integration-validation-2026-10-09/full-api-pg16.txt` | 75306 | 888 | `07f985ef0b7697337800182ce621d7485081a0c4e11592e63fb3c49a57cd0456` | `d7e38305e4` |
| `reports/integration-validation-2026-10-09/full-ui.txt` | 12860 | 176 | `22ea51431f0132138859eeea4daf04a4db88187b3d65a98d98a8f8e360e97ccf` | `d7e38305e4` |
| `reports/production-verifier-2026-10-12/264da539-582b-46e6-8120-74b8b167e8f2/native-result.json` | 12534 | 324 | `d26430fda902e18418d4326e97c1a39092cc8b1daf75046c32b05f12a844244d` | `283715fdf3` |
| `reports/production75-recovery-2026-10-11/catalog95-fly-db.json` | 561294 | 1 | `ac7c464d1d383b3fd535ef09815f4156c125b3f395e55a899959bf41a3d04092` | `87adc3eb21` |
| `reports/production75-recovery-2026-10-11/catalog95-growthos_staging.json` | 561294 | 1 | `4c11a5053299344960f86da69873a66a7dce879b4800feff22e64e0bac8f012a` | `87adc3eb21` |
| `reports/production75-recovery-2026-10-11/local-05010f4b-4153-4abf-a9ed-e907cce1d426.json` | 484706 | 14886 | `ff02bbdc1995bc3b7429f9759824d806c750201924043ca69e50fdb28d78f0fc` | `8df64dc720` |
| `reports/production75-recovery-2026-10-11/local-90be0806-3986-480d-b7a5-3c9d19299756.json` | 476232 | 14644 | `bd75b3c4eb9a5119104b9be31d16b8abfee5b1af0a83087bb4bb7c048494ebfe` | `87adc3eb21` |
| `reports/production75-recovery-2026-10-11/local-acceptance.json` | 484706 | 14886 | `ff02bbdc1995bc3b7429f9759824d806c750201924043ca69e50fdb28d78f0fc` | `8df64dc720` |
| `reports/production75-recovery-2026-10-11/source-manifest.json` | 24443 | 818 | `4f62b261bcf0babe7be0c845e69f70459307441a33d7b2b5f14e039ff087d1bb` | `87adc3eb21` |
| `reports/release-integration-2026-10-12/review-integrated-customer-import-and-launch.json` | 11374 | 195 | `7329eef3f479a8f14a41553cd8cd17ae8215c8f3ea07b09bbaea3a42236366f8` | `8df64dc720` |
| `reports/release-preparation-2026-10-09/current-hosted-metadata.json` | 10864 | 343 | `d2363457101b0ca229bc2ee6d98be8bd33079f75f39a953cda715809e731140a` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/evidence-manifest.json` | 15121 | 433 | `54a1ec04b2dc5d9fdcd5eee0739c2ab3307edd4a77532351c0656ecd02eede86` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-actual-first-attempt-archive.json` | 109489 | 59 | `f829e989ec853f9657dfd967570976d11bfb96f06a437369bb624c9ae52f7589` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt2-before-stderr-type-repair-archive.json` | 85240 | 19 | `402d0b1d4df9f99eda7e820e0c0393120fc21c4b0f6a76f9679327b2e632caff` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt2-explicit-endpoint-source-archive.json` | 90827 | 29 | `9241cd803a6e5f9e6da3cb5201bcc382b559fbd0593ad60e934c6520898e5205` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt2-source-manifest.json` | 54635 | 913 | `49d0ae1ecdc2290a1bb3c4728c3de3fbf71349138a81e998a006dc12831a1890` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt3-before-platform-binding-archive.json` | 85619 | 19 | `8bd72c909b8d4c65bb1ed47b1cbf63861fb95e8224267c5628710deb3a782821` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt3-result-e8c1ace4-d76a-49b5-b87d-9565aef71da3.json` | 10983 | 417 | `9d7b867eb45480bdf1765f7c4add0da074f738d897de1247afa004f779bf8a67` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-attempt3-source-manifest.json` | 54904 | 917 | `1c1a761a1d4cada324eefc4f9b62f3af821e190310b5bac9fe68c2250e07600c` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-before-creation-repair-archive.json` | 89454 | 24 | `11a58ceb053bf353b7401711a583eae47098128585e321db6a1b3e91d4d1c4a9` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-before-zero-candidate-repair-archive.json` | 89282 | 19 | `93027fe7931edd5d1d74e93bc43f4812fb76fdddceea20fe86d1d31853b40d0d` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-first-source-archive.json` | 100876 | 29 | `fedca59aea4d5d98119061637e18738cb367f797ee5c3a4edc8b8e5433007598` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/local142-source-manifest.json` | 54635 | 913 | `d080120cc1583cc5121e1cd4fffb16d5f52b8a38d33322bec8b8cb4c022f7e23` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/tool-source/local-fixture-pure.mjs.txt` | 15059 | 177 | `c1baa6ea0a32baea38f49dc3a13c3dba090f0269ebd43f5d9bf8363e909cabfd` | `a85186e8d8` |
| `reports/release-preparation-2026-10-09/tool-source/local142-pg16-driver.mjs.txt` | 22022 | 51 | `edc2300228eae10ea5b7157ae11d3720368b0b60eaa52a5d9f7c9e07b16eee8a` | `a85186e8d8` |
| `reports/saved-scheduling-corrected-recovery-20261014-task12-corrected-20261015040833664/manifest.json` | 873240 | 18399 | `8a144f3e7ba42b78428acd6f13ccf8af5650479bd828cbcfcf8d7f7204f3bcb6` | `76ee0b6b3c` |
| `reports/saved-scheduling-corrected-recovery-20261014-task12-corrected-20261015040833664/receipt-storage-provenance.json` | 21462 | 377 | `08869bd3aa67f20cd427f9aed8a9d254efe91621b1babadc74ff27bce51fc277` | `76ee0b6b3c` |
| `reports/saved-scheduling-corrected-recovery-20261014-task12-corrected-20261015040833664/standalone-green.stdout.jsonl` | 23508 | 1 | `503ec1266569c722a26747a9f33fd760e3b511330b515a5edcb2d5982364099f` | `76ee0b6b3c` |
| `reports/saved-scheduling-recovery-refresh-20261014-task12-181716/manifest.json` | 36709 | 852 | `71485d52aba276a199e78fc5356805a5325de649dc917fbc214bde3cbbbd8f8c` | `327148b4c1` |
| `reports/saved-scheduling-recovery-refresh-20261014-task12-181716/receipt-storage-provenance.json` | 11673 | 165 | `0a5bde124d77d84f9c928d5263a45b646e3f401a3dc9de2c446062957b94eb7f` | `4d9b6d8879` |
| `reports/saved-scheduling-recovery-refresh-20261014-task12-181716/standalone-green.stdout.jsonl` | 23415 | 1 | `b99a89d594f70dcc031927ca89c148c840f1052cd2b39a4f695229efbf122b5c` | `327148b4c1` |
| `reports/saved-scheduling-recovery-test-refresh-20261014-task12-test-pin-20261015024104778/manifest.json` | 838054 | 17629 | `5bed66a382a81f5faadcd26fb4a16cc055456f5e5e9aecac67774f8ff9cab67a` | `f94fa6aa84` |
| `reports/saved-scheduling-recovery-test-refresh-20261014-task12-test-pin-20261015024104778/standalone-green.stdout.jsonl` | 23415 | 1 | `f15b609f4cc38c50dffc3ed789fde252c06f16141f84679300f01c237c0f8557` | `f94fa6aa84` |
| `reports/saved-scheduling-release-20261014/packet.json` | 83677 | 1824 | `2fea84339c5a80be81cf29a07879892ea9160e82c82e3a252b7cc9dc8f148c31` | `c610165183` |
| `reports/staging-observation-2026-10-10/fixtures/local-observer-smoke.json` | 665236 | 23606 | `2d1b1249aef79755ab88ae588dfdb6c62783631d99a00d8a8dd414dcd4f5672c` | `72b916691a` |
| `reports/staging-observation-2026-10-10/upgrade-fixtures/local-migration-acceptance.json` | 130902 | 4318 | `8ececa3cfb6656c4814bb7f628836fed1ae643bfaadee20bfcad3551bcfda7e0` | `b65eda8a9c` |
| `reports/staging-observation-2026-10-10/upgrade-fixtures/local-migration-ad8b9b05-a31c-4086-98c1-19678abd9381.json` | 129717 | 4269 | `176ab6ba29f51065648fbf05d85d13061fe6c3811f4d97f63aca847ce8c6db05` | `f6ad506fed` |
| `reports/staging-observation-2026-10-10/upgrade-fixtures/local-migration-b4cec836-18f1-4109-8d03-c4dfd1503a30.json` | 129716 | 4269 | `5af282684fed69235ee4e2e27aa6fdca974ddce66be855a090f7c57301482e11` | `f6ad506fed` |
| `reports/staging-observation-2026-10-10/upgrade-fixtures/local-migration-f8df3698-4942-4b6c-8fd1-88a2e01663e0.json` | 130902 | 4318 | `8ececa3cfb6656c4814bb7f628836fed1ae643bfaadee20bfcad3551bcfda7e0` | `b65eda8a9c` |
| `reports/staging-schema-preview-2026-09-30/meta/0000_snapshot.json` | 376799 | 13824 | `cb4e9ddf8c5e49a1f93ce299415408586bad0c075d1b3280c294dc6ff1e458e3` | `96770a3146` |
| `reports/staging-schema-preview-2026-09-30/meta/0001_snapshot.json` | 377419 | 13843 | `5815b09594c1c5693a02a60a664195b43d0524c4639da9a419e61392638968b1` | `c050067000` |

## Restoring a file

```sh
git show 02306ef8654ae00fcc4c13a3f0fe24248aa415d6:<path> > <path>
# or copy from C:\Forge\artifacts\growthos-evidence-archive\<path> and compare its SHA-256 with evidence-index.json
```

Scripts that write new run evidence (for example `scripts/production75-live-local.mjs`, `scripts/production75-operator-local.mjs`, `scripts/production75-local.mjs`, `scripts/staging-migration-local.mjs`) still write into `reports/`; `scripts/production75-live-runner.mjs` takes its oracle directory as an absolute argument, so archived oracle runs are used by passing the archive path.
